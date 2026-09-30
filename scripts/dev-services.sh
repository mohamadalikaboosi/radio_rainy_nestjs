#!/usr/bin/env bash
# Starts local Postgres + Redis for tests when docker isn't available (e.g. cloud sandbox).
set -u
pg_isready -q -h 127.0.0.1 || { pg_ctlcluster 16 main start 2>/dev/null; for _ in $(seq 1 20); do pg_isready -q -h 127.0.0.1 && break; sleep 0.5; done; }
redis-cli ping >/dev/null 2>&1 || { redis-server --daemonize yes >/dev/null; sleep 0.5; }
pg_isready -h 127.0.0.1 && redis-cli ping
