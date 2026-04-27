#!/bin/bash
#SBATCH -J exp004_nested_outputs
#SBATCH -o logs/exp004_nested_outputs.out
#SBATCH -N 1
#SBATCH --ntasks=1

set -eu
cd "${SLURM_SUBMIT_DIR:-$(pwd)}"

BASE_DIR="output/exp004_nested_output_collection_case/model_a/seed_0007/eval"
mkdir -p logs
mkdir -p "${BASE_DIR}/figures"
mkdir -p "${BASE_DIR}/tables"

echo "nested-output start $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
hostname
echo "best_iou=0.71" > "${BASE_DIR}/tables/summary.txt"
echo "figure-placeholder" > "${BASE_DIR}/figures/curve.txt"
sleep 5
echo "nested-output end $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
