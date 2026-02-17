import time

from worker.jobs import diagnostics_job, expire_holds_job, process_sms_queue_once


if __name__ == "__main__":
    while True:
        process_sms_queue_once(timeout_s=1)
        expire_holds_job()
        diagnostics_job()
        time.sleep(5)
