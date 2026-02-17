import time

from worker.jobs import expire_holds_job


if __name__ == "__main__":
    # V1 Build Scope: Render background worker process scaffold.
    while True:
        expire_holds_job()
        time.sleep(30)
