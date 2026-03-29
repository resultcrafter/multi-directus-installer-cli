#!/bin/bash
set -e

PROJECT_NAME=""
DB_HOST="localhost"
DB_PORT="5432"
OUTPUT_PATH=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: $0 --project-name <name> [--host <host>] [--port <port>] [--output <path>]"
  echo ""
  echo "Creates a PostgreSQL database and user for a project."
  echo ""
  echo "Options:"
  echo "  --project-name    Project name (required) - used for naming DB and user"
  echo "  --host           PostgreSQL host (default: localhost)"
  echo "  --port           PostgreSQL port (default: 5432)"
  echo "  --output         Output path for env file (default: current directory)"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
  --project-name | -n)
    PROJECT_NAME="$2"
    shift 2
    ;;
  --host | -h)
    DB_HOST="$2"
    shift 2
    ;;
  --port | -p)
    DB_PORT="$2"
    shift 2
    ;;
  --output | -o)
    OUTPUT_PATH="$2"
    shift 2
    ;;
  *)
    echo "Unknown option: $1"
    usage
    ;;
  esac
done

if [[ -z "$PROJECT_NAME" ]]; then
  echo "Error: --project-name is required" >&2
  exit 1
fi

if ! command -v psql &>/dev/null; then
  echo "Error: psql is not installed" >&2
  echo "Please install PostgreSQL client:" >&2
  echo "  macOS: brew install postgresql" >&2
  echo "  Ubuntu/Debian: apt-get install postgresql-client" >&2
  exit 1
fi

# Use PGPASSWORD if provided, otherwise use default 'postgres'
PGPASSWORD="${PGPASSWORD:-postgres}"

# For localhost, use 127.0.0.1 to avoid GSSAPI issues on macOS
CHECK_HOST="$DB_HOST"
if [[ "$DB_HOST" == "localhost" ]]; then
  CHECK_HOST="127.0.0.1"
fi

if ! PGPASSWORD="$PGPASSWORD" psql -h "$CHECK_HOST" -p "$DB_PORT" -U postgres -c "SELECT 1" &>/dev/null; then
  echo "Error: Cannot connect to PostgreSQL at $DB_HOST:$DB_PORT" >&2
  exit 1
fi

SANITIZED_NAME=$(echo "$PROJECT_NAME" | sed 's/[^a-zA-Z0-9_]/_/g' | tr '[:upper:]' '[:lower:]')
DB_NAME="${SANITIZED_NAME}_db"
DB_USER="${SANITIZED_NAME}_usr"
DB_PASSWORD=$(openssl rand -base64 32)

echo "Creating database and user for project: $PROJECT_NAME"
echo "Database: $DB_NAME"
echo "User: $DB_USER"

PGPASSWORD="$PGPASSWORD" psql -h "$CHECK_HOST" -p "$DB_PORT" -U postgres -c "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 ||
  PGPASSWORD="$PGPASSWORD" psql -h "$CHECK_HOST" -p "$DB_PORT" -U postgres -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD'"

PGPASSWORD="$PGPASSWORD" psql -h "$CHECK_HOST" -p "$DB_PORT" -U postgres -c "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 ||
  PGPASSWORD="$PGPASSWORD" psql -h "$CHECK_HOST" -p "$DB_PORT" -U postgres -c "CREATE DATABASE $DB_NAME OWNER $DB_USER"

PGPASSWORD="$PGPASSWORD" psql -h "$CHECK_HOST" -p "$DB_PORT" -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER"

cat >"${OUTPUT_PATH:-.}/new-project-db-env" <<EOF
DB_DATABASE=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
EOF

CONNECTION_STRING="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo ""
echo "Database created successfully!"
echo "Connection string: $CONNECTION_STRING"
echo "Credentials saved to: ${OUTPUT_PATH:-.}/new-project-db-env"
