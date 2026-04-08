#!/bin/bash
# Setup daily AI Newsroom digest cron job (local backup)
# Usage: ./scripts/setup-cron.sh [hour] [minute]
# Default: 12:00 PM (noon)

HOUR=${1:-12}
MINUTE=${2:-0}
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Build the cron line
CRON_LINE="${MINUTE} ${HOUR} * * * cd ${PROJECT_DIR} && /usr/bin/npm run digest >> ${PROJECT_DIR}/logs/digest.log 2>&1"

# Check if already installed
if crontab -l 2>/dev/null | grep -q "ai-newsroom"; then
  echo "Cron job already exists. Removing old one..."
  crontab -l | grep -v "ai-newsroom" | crontab -
fi

# Add new cron job with a comment
(crontab -l 2>/dev/null; echo "# ai-newsroom daily digest"; echo "${CRON_LINE}") | crontab -

# Create logs directory
mkdir -p "${PROJECT_DIR}/logs"

echo "✅ Cron job installed: digest will run daily at ${HOUR}:$(printf '%02d' ${MINUTE})"
echo "   Logs: ${PROJECT_DIR}/logs/digest.log"
echo "   To remove: crontab -e and delete the ai-newsroom lines"
