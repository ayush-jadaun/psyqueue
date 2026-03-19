#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

K6="${K6:-k6}"

echo "=== k6 Load Test: PsyQueue vs BullMQ ==="
echo ""

# Flush Redis between tests
echo "Flushing Redis..."
redis-cli -p 6381 FLUSHALL > /dev/null 2>&1 || echo "Warning: could not flush Redis"
echo ""

echo "--- Testing PsyQueue (port 3001) ---"
$K6 run --env TARGET=http://localhost:3001 --summary-export psyqueue-results.json load-test.js
echo ""

# Flush Redis between tests
echo "Flushing Redis between tests..."
redis-cli -p 6381 FLUSHALL > /dev/null 2>&1 || echo "Warning: could not flush Redis"
echo ""

echo "--- Testing BullMQ (port 3002) ---"
$K6 run --env TARGET=http://localhost:3002 --summary-export bullmq-results.json load-test.js
echo ""

echo "=== Results saved to psyqueue-results.json and bullmq-results.json ==="
