#!/usr/bin/env bash
# Starts the local PostgreSQL used by the integration suite and smoke script.
#
# Kept as a script because the data directory lives outside /tmp: /tmp is wiped
# between sessions in this environment, which silently loses the database and
# makes every integration run fail with "connection refused" for no visible
# reason.
#
# Usage:
#   scripts/pg-local.sh start     start (or no-op if already running)
#   scripts/pg-local.sh stop
#   scripts/pg-local.sh status
#   scripts/pg-local.sh recreate  drop and rebuild the databases, then migrate
set -euo pipefail

PGDATA="${RENDERFLOW_PGDATA:-$HOME/.renderflow-pgdata}"
PGPORT="${RENDERFLOW_PGPORT:-5433}"
PGLOG="${RENDERFLOW_PGLOG:-${PGDATA}/../renderflow-pg.log}"
SOCKET_DIR="${PGDATA}/run"
DB_USER=renderflow
DB_PASS=renderflow
DATABASES=(renderflow renderflow_test)

export PGPASSWORD="$DB_PASS"

running() {
  # Note the unquoted expansion: the argument is a command line, and quoting it
  # would make bash look for a binary literally named "pg_ctl -D /path".
  # shellcheck disable=SC2086
  $1 status >/dev/null 2>&1
}

start() {
  if running "pg_ctl -D $PGDATA"; then
    echo "postgres already running on :$PGPORT"
    return 0
  fi

  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    # initdb refuses a non-empty directory, so clear a half-made one. Only safe
    # because this script owns the directory and nothing else writes to it.
    rm -rf "$PGDATA"
    mkdir -p "$PGDATA"
    initdb -D "$PGDATA" -U "$DB_USER" --auth=trust -E UTF8 >/dev/null
  fi

  mkdir -p "$SOCKET_DIR"
  pg_ctl -D "$PGDATA" -l "$PGLOG" \
    -o "-p $PGPORT -k $SOCKET_DIR -c listen_addresses=127.0.0.1" start >/dev/null

  for _ in $(seq 1 30); do
    psql -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d postgres -c 'SELECT 1' >/dev/null 2>&1 && break
    sleep 0.5
  done

  psql -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d postgres \
    -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null

  for db in "${DATABASES[@]}"; do
    if ! psql -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d postgres \
      -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
      psql -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d postgres \
        -c "CREATE DATABASE $db OWNER $DB_USER;" >/dev/null
    fi
    # gen_random_uuid() lives in pgcrypto on PG13 and in core on PG18; created
    # idempotently so either version works.
    psql -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$db" \
      -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null 2>&1 || true
  done

  echo "postgres ready on 127.0.0.1:$PGPORT (datadir $PGDATA)"
}

stop() {
  running "pg_ctl -D $PGDATA" && pg_ctl -D "$PGDATA" stop -m fast >/dev/null
  echo "postgres stopped"
}

status() {
  running "pg_ctl -D $PGDATA" && echo "running on :$PGPORT" || echo "not running"
}

recreate() {
  stop || true
  for db in "${DATABASES[@]}"; do
    psql -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS $db;" >/dev/null 2>&1 || true
  done
  start
  for db in "${DATABASES[@]}"; do
    DATABASE_URL="postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PGPORT/$db" \
      pnpm --filter @renderflow/db run db:migrate >/dev/null
    echo "migrated $db"
  done
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  recreate) recreate ;;
  *) echo "usage: $0 {start|stop|status|recreate}" >&2; exit 2 ;;
esac