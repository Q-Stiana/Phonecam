import asyncio
import base64
import hashlib
import struct


HOST = "127.0.0.1"
PORT = 8001
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

clients = set()


async def read_http_headers(reader):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = await reader.read(1024)
        if not chunk:
            return None
        data += chunk
        if len(data) > 16384:
            return None
    return data.decode("utf-8", errors="replace")


def header_value(headers, name):
    prefix = f"{name.lower()}:"
    for line in headers.splitlines():
        if line.lower().startswith(prefix):
            return line.split(":", 1)[1].strip()
    return None


async def websocket_handshake(reader, writer):
    headers = await read_http_headers(reader)
    if not headers:
        return False

    key = header_value(headers, "Sec-WebSocket-Key")
    if not key:
        return False

    accept = base64.b64encode(
        hashlib.sha1((key + WEBSOCKET_GUID).encode("ascii")).digest()
    ).decode("ascii")

    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n"
        "\r\n"
    )
    writer.write(response.encode("ascii"))
    await writer.drain()
    return True


async def read_frame(reader):
    first_two = await reader.readexactly(2)
    first, second = first_two
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F

    if length == 126:
        length = struct.unpack("!H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", await reader.readexactly(8))[0]

    mask = await reader.readexactly(4) if masked else None
    payload = await reader.readexactly(length) if length else b""

    if mask:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

    return opcode, payload


def make_frame(message):
    payload = message.encode("utf-8")
    length = len(payload)
    header = bytearray([0x81])

    if length < 126:
        header.append(length)
    elif length <= 65535:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))

    return bytes(header) + payload


async def send_text(writer, message):
    writer.write(make_frame(message))
    await writer.drain()


async def broadcast(sender, message):
    dead_clients = []
    for client in clients:
        if client is sender:
            continue
        try:
            await send_text(client, message)
        except (ConnectionError, asyncio.IncompleteReadError, BrokenPipeError):
            dead_clients.append(client)

    for client in dead_clients:
        clients.discard(client)


async def handle_client(reader, writer):
    peer = writer.get_extra_info("peername")
    if not await websocket_handshake(reader, writer):
        writer.close()
        await writer.wait_closed()
        return

    clients.add(writer)
    print(f"client connected: {peer} ({len(clients)} total)")

    try:
        while True:
            opcode, payload = await read_frame(reader)

            if opcode == 0x8:
                break
            if opcode == 0x9:
                writer.write(b"\x8a\x00")
                await writer.drain()
                continue
            if opcode != 0x1:
                continue

            message = payload.decode("utf-8", errors="replace")
            print(message)
            await broadcast(writer, message)
    except (ConnectionError, asyncio.IncompleteReadError, BrokenPipeError):
        pass
    finally:
        clients.discard(writer)
        writer.close()
        await writer.wait_closed()
        print(f"client disconnected: {peer} ({len(clients)} total)")


async def main():
    server = await asyncio.start_server(handle_client, HOST, PORT)
    print(f"WebSocket relay listening on ws://{HOST}:{PORT}")
    print("Connect the browser and TouchDesigner WebSocket DAT as clients.")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nrelay stopped")
