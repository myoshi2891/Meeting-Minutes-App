import os
from pathlib import Path

import uvicorn

from .phase1 import create_app, start_server_state


def main() -> None:
    data_dir = Path(os.environ.get("MINUTES_DATA_DIR", "private/phase1-data"))
    state = start_server_state(data_dir)
    print(f"Token refreshed: {state.data_dir / 'token'} (enter its contents in the browser)", flush=True)
    uvicorn.run(create_app(state), host="127.0.0.1", port=43117, access_log=False)


if __name__ == "__main__":
    main()
