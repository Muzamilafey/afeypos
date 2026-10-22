#!/usr/bin/env sh
# Development helper (Linux/macOS): starts a single-node MongoDB replica set in ./data/db on port 27017.
set -e
DB_DIR="$(dirname "$0")/../data/db"
mkdir -p "$DB_DIR"
MONGOD="${MONGOD:-mongod}"
"$MONGOD" --replSet rs0 --dbpath "$DB_DIR" --port 27017 --bind_ip 127.0.0.1 --fork --logpath "$DB_DIR/mongod.log"
sleep 2
mongosh --quiet --eval 'try { rs.status() } catch (e) { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] }) }' || echo "Run rs.initiate() manually in mongosh if this is the first start"
