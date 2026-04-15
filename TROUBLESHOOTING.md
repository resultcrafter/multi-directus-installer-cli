# Troubleshooting: 3-Step Directus Setup

This guide covers common issues when deploying Directus using the CLI's 3-step workflow on a self-hosted server.

## Prerequisites

Before starting, ensure:
- [ ] `gh` CLI is installed: https://cli.github.com
- [ ] `gh auth login` has been run and authenticated
- [ ] GitHub user has access to `resultcrafter/multi-directus-starters` (for private templates)
- [ ] Docker is installed and running
- [ ] PostgreSQL is accessible (external or CLI's built-in shared postgres)
- [ ] DNS is configured for your subdomain

---

## Step 1: Start Shared PostgreSQL

### Issue: Shared PostgreSQL won't start

```bash
cd ~/.multi-directus-installer-cli/scripts/shared-postgres
docker compose up -d
docker compose logs
```

**Check:** Is port 5432 already in use?
```bash
docker ps | grep postgres
ss -tlnp | grep 5432
```

**Solution:** Stop other postgres containers or change the port mapping in `docker-compose.yaml`.

---

## Step 2: Initialize Blank Directus (`init --blank`)

### Issue: TTY initialization failed

**Error:**
```
SystemError: TTY initialization failed: uv_tty_init returned EINVAL
Code: ERR_TTY_INIT_FAILED
```

**Cause:** Running in non-interactive environment (SSH, scripts, containers).

**Solution:** Use `script` command to fake a TTY:
```bash
script -q -c "multi-directus-installer-cli init my-project --blank" /dev/null
```

Or use environment variable to skip prompts (if available in your CLI version).

---

### Issue: 404 Not Found when downloading template

**Error:**
```
Failed to download https://api.github.com/repos/resultcrafter/multi-directus-starters/tarball/main: 404 Not Found
```

**Cause:** 
- GitHub authentication token not available to giget
- GitHub user lacks access to the private repository

**Diagnosis:**
```bash
# Check if gh is authenticated
gh auth status

# Check repo access
gh api repos/resultcrafter/multi-directus-starters
```

**Solutions:**

1. **Set GIGET_AUTH environment variable:**
```bash
export GIGET_AUTH=$(gh auth token)
multi-directus-installer-cli init my-project --blank --template=blank
```

2. **Or use local template (if already cloned):**
```bash
multi-directus-installer-cli init my-project --blank --template=/path/to/local/blank
```

3. **Verify GitHub access to private repo:**
```bash
gh auth login
# Ensure user has read access to resultcrafter/multi-directus-starters
```

---

### Issue: Interactive prompts hang or timeout

**Cause:** Input piping doesn't work well with clack prompts.

**Solution:** Run in a proper terminal or use `script` command (see above).

---

## Step 3: Apply Template (`apply`)

### Issue: Authentication fails when applying template

**Error:**
```
401 Unauthorized
```

**Cause:** Invalid or expired Directus token.

**Solution:** 
1. Create a new Static Access Token in Directus admin UI:
   - Go to Settings → Users → Your User → Tokens
   - Create new token with Full Access

2. Use the token:
```bash
multi-directus-installer-cli apply \
  --directusUrl=https://your-directus.example.com \
  --directusToken="your-new-token" \
  --templateLocation=./my-template
```

---

### Issue: Template apply fails with database errors

**Error:**
```
Database error: relation "..." does not exist
```

**Cause:** Schema not loaded properly or migrations failed.

**Solution:**
```bash
# Clear and re-apply
# 1. Backup your data first!
# 2. Clear Directus cache
docker compose exec directus sh -c "rm -rf /directus/data/cache/*"
# 3. Re-apply template
multi-directus-installer-cli apply --directusUrl=... --directusToken=... --templateLocation=...
```

---

## Nginx / HTTPS Issues

### Issue: SSL certificate fails to provision

**Error:**
```
Certbot: Failed to validate domain
```

**Causes & Solutions:**

1. **DNS not propagated:**
```bash
dig +short your-domain.example.com
# Should return your server IP
```

2. **Nginx not reloading for ACME challenge:**
```bash
# Ensure nginx serves .well-known/acme-challenge/
nginx -t
systemctl reload nginx
```

3. **Firewall blocking port 80:**
```bash
ufw allow 80/tcp
ufw allow 443/tcp
```

---

### Issue: Directus returns 400/401/403 after login

**Symptoms:**
- Login appears successful
- Subsequent API calls fail with 401/403
- `POST /auth/refresh` returns 400

**Cause:** Cookie misconfiguration when accessing via HTTPS reverse proxy.

**Key environment variables to verify:**

```bash
# PUBLIC_URL must match the full URL users access
PUBLIC_URL=https://your-domain.example.com

# Cookie domain must match the domain being accessed
REFRESH_TOKEN_COOKIE_DOMAIN=your-domain.example.com
SESSION_COOKIE_DOMAIN=your-domain.example.com

# Secure cookies for HTTPS
REFRESH_TOKEN_COOKIE_SECURE=true
SESSION_COOKIE_SECURE=true

# CORS origin must match
CORS_ORIGIN=https://your-domain.example.com
```

**Solution:** Update `.env` and restart:
```bash
docker compose down
docker compose up -d
```

---

### Issue: 502 Bad Gateway from nginx

**Cause:** Directus container not responding.

**Diagnosis:**
```bash
# Check if Directus is running
docker ps | grep directus

# Check if Directus port is responding
curl http://127.0.0.1:8036/server/info

# Check Directus logs
docker logs your-directus-container --tail 50
```

**Common fixes:**
1. **Directus still starting:** Wait 30-60 seconds
2. **Port conflict:** Check `docker port` matches nginx proxy_pass
3. **Restart Directus:**
```bash
docker compose restart directus
```

---

### Issue: Nginx upstream timed out

**Error:**
```
504 Gateway Timeout
```

**Solution:** Increase proxy timeouts in nginx config:
```nginx
proxy_read_timeout 86400;
proxy_send_timeout 300;
```

---

## Database Issues

### Issue: Directus can't connect to PostgreSQL

**Error:**
```
Database is not ready!
```

**Causes:**

1. **PostgreSQL container down:**
```bash
docker ps | grep postgres
docker compose -f /path/to/postgres/docker-compose.yaml up -d
```

2. **Wrong connection credentials:**
```bash
# Test connection
docker exec postgres-container psql -U username -d database -c "SELECT 1"
```

3. **Host path wrong (Docker bridge):**
```bash
# For external PostgreSQL accessed from Docker, use:
DB_HOST=172.17.0.1  # Docker bridge gateway
# NOT localhost when connecting from inside a container
```

---

### Issue: Database exists but Directus shows "Database is not ready"

**Diagnosis:**
```bash
# Check if Directus can reach the database
docker exec directus-container sh -c "pg_isready -h \$DB_HOST -p \$DB_PORT -U \$DB_USER -d \$DB_DATABASE"
```

**Solution:** Restart Directus after PostgreSQL is fully ready:
```bash
# Wait for postgres to be healthy
docker compose up -d postgres
docker compose wait postgres
# Then start directus
docker compose up -d directus
```

---

## Port Conflicts

### Issue: Port already in use

**Error:**
```
Bind for 0.0.0.0:8036 failed: port already allocated
```

**Find what's using the port:**
```bash
ss -tlnp | grep 8036
docker ps | grep 8036
```

**Solution:** Either stop the conflicting service or change Directus port in `.env`:
```bash
DIRECTUS_PORT=8037
# And update docker-compose port mapping:
# - "127.0.0.1:8037:8055"
# And update nginx proxy_pass
```

---

## Quick Reference: Common Commands

```bash
# Restart all services
docker compose down && docker compose up -d

# View logs
docker compose logs -f directus
docker compose logs -f postgres

# Check health
curl http://127.0.0.1:8036/server/info

# Test database connection from Directus container
docker exec -it directus-container sh
pg_isready -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_DATABASE

# Clear Directus cache
docker exec directus-container sh -c "rm -rf /directus/data/cache/*"

# Update environment and recreate
docker compose down
# Edit .env
docker compose up -d
```

---

## Getting Help

If issues persist:

1. **Collect logs:**
```bash
docker compose logs > debug.log 2>&1
```

2. **Check Directus version:**
```bash
docker exec directus-container directus --version
```

3. **Verify Docker networking:**
```bash
docker network inspect bridge
docker network inspect your-project_default
```

4. **Check system resources:**
```bash
df -h
free -h
docker stats --no-stream
```
