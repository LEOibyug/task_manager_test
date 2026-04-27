#!/bin/bash
#SBATCH -J task_manager_smoke
#SBATCH -o logs/task_manager_smoke.out
#SBATCH -N 1
#SBATCH --ntasks=1

set -eu
cd "${SLURM_SUBMIT_DIR:-$(pwd)}"

mkdir -p logs
mkdir -p output/exp001_smoke_test/model_config/task_manager_smoke

echo "job-start $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
hostname
echo "${SLURM_JOB_ID:-no_job_id}" > output/exp001_smoke_test/model_config/task_manager_smoke/job_id.txt
echo "smoke test ok" > output/exp001_smoke_test/model_config/task_manager_smoke/result.txt
sleep 5
echo "job-end $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

