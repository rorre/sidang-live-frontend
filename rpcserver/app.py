import asyncio
import os
from typing import Annotated
from fastapi import FastAPI, Header, WebSocket
from pydantic import BaseModel

app = FastAPI()
TOKEN = os.getenv("TOKEN") or "skibidirizzohiogyatt"


class ConnectionManager:
    def __init__(self):
        self.current = {"title": "Preparing", "page": 1}
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def update_current(self, title: str, page: int):
        self.current["title"] = title
        self.current["page"] = page

        await self.broadcast()

    async def send_current(self, websocket: WebSocket):
        await websocket.send_json(self.current)

    async def broadcast(self):
        for connection in self.active_connections:
            await self.send_current(connection)


manager = ConnectionManager()


class RPCMessage(BaseModel):
    title: str
    page: int


@app.post("/rpc")
async def rpc(message: RPCMessage, authorization: Annotated[str | None, Header()]):
    if authorization != TOKEN:
        return {"status": "unauthorized"}

    await manager.update_current(message.title, message.page)
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    await manager.send_current(websocket)

    try:
        while True:
            await websocket.send_text("1")
            await asyncio.sleep(10)
    except Exception:
        manager.disconnect(websocket)
