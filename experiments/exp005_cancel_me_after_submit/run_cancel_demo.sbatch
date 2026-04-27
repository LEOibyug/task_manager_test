#!/bin/bash
#SBATCH -J exp005_cancel_demo
#SBATCH -o logs/exp005_cancel_demo.out
#SBATCH -N 1
#SBATCH --ntasks=1

set -eu
cd "${SLURM_SUBMIT_DIR:-$(pwd)}"

TARGET_DIR="output/exp005_cancel_me_after_submit/cancel_demo"
mkdir -p logs
mkdir -p "${TARGET_DIR}"

echo "cancel-demo start $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
hostname
echo "waiting for cancel" > "${TARGET_DIR}/state.txt"
sleep 120
echo "finished without cancel" > "${TARGET_DIR}/finished.txt"
echo "cancel-demo end $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
