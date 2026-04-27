#!/usr/bin/env bash
set -eu

mkdir -p logs
mkdir -p output/exp001_smoke_test/model_config/task_manager_smoke
echo "prepared $(date -u +"%Y-%m-%dT%H:%M:%SZ")" > output/exp001_smoke_test/model_config/task_manager_smoke/prepared.txt

