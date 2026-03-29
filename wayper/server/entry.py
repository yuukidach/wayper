import multiprocessing
import sys

from wayper.cli import cli
from wayper.server.api import run as run_api


def main():
    from wayper.logging import setup_logging

    setup_logging()
    if getattr(sys, "frozen", False):
        # We are running in a PyInstaller bundle
        if len(sys.argv) > 1:
            # If arguments are passed, run CLI
            cli()
        else:
            # No args, run API server
            # multiprocessing.freeze_support() is needed for Windows if using multiprocessing
            multiprocessing.freeze_support()
            run_api()
    else:
        # Dev mode / Script execution
        if len(sys.argv) > 1:
            cli()
        else:
            run_api()


if __name__ == "__main__":
    main()
