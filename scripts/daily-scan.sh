#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[Artemis] Daily scan triggered at $(date)"

# Run the full scan + report + email check pipeline via tsx
cd "$SCRIPT_DIR/.." && npx tsx scripts/daily-pipeline.ts

echo "[Artemis] Daily scan complete at $(date)"
