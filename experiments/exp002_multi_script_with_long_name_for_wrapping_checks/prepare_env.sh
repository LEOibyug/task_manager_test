#!/bin/bash
set -eu

mkdir -p logs
mkdir -p output/exp002_multi_script_with_long_name_for_wrapping_checks/manual_prepare
echo "prepare finished at $(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  > output/exp002_multi_script_with_long_name_for_wrapping_checks/manual_prepare/prepare.txt
