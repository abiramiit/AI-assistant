import os
import sys
import uvicorn

if __name__ == "__main__":
    # Ensure this directory is in Python path
    service_dir = os.path.dirname(os.path.abspath(__file__))
    if service_dir not in sys.path:
        sys.path.insert(0, service_dir)

    uvicorn.run("main:app", host="127.0.0.1", port=8765, log_level="info")
