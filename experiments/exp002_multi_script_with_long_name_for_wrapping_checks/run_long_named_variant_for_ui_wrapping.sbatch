#!/bin/bash
#SBATCH -J exp002_variant_with_a_very_long_job_name_for_ui_wrapping
#SBATCH -o logs/exp002_variant_with_a_very_long_job_name_for_ui_wrapping.out
#SBATCH -N 1
#SBATCH --ntasks=1

set -eu
cd "${SLURM_SUBMIT_DIR:-$(pwd)}"

TARGET_DIR="output/exp002_multi_script_with_long_name_for_wrapping_checks/variant_with_a_very_long_directory_name_for_wrapping_checks/checkpoints"
mkdir -p logs
mkdir -p "${TARGET_DIR}"

echo "variant start $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
hostname
echo "checkpoint-ready" > "${TARGET_DIR}/epoch_0001.ckpt"
sleep 6
echo "variant end $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
