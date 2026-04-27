#!/bin/bash
#SBATCH -J exp002_fast_check
#SBATCH -o logs/exp002_fast_check.out
#SBATCH -N 1
#SBATCH --ntasks=1

set -eu
cd "${SLURM_SUBMIT_DIR:-$(pwd)}"

TARGET_DIR="output/exp002_multi_script_with_long_name_for_wrapping_checks/fast_check/metrics"
mkdir -p logs
mkdir -p "${TARGET_DIR}"

echo "fast-check start $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
hostname
printf "accuracy=0.98\nloss=0.02\n" > "${TARGET_DIR}/summary.txt"
sleep 4
echo "fast-check end $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
