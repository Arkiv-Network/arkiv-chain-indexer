import asyncio
import json
import os
import ssl
import time
from urllib.parse import urlparse

rpc_url = "https://braga.hoodi.arkiv.network/rpc"
headers = {"Content-Type": "application/json"}
braga_no_limit_key = os.getenv("BRAGA_NO_LIMIT_KEY")
if braga_no_limit_key:
    headers["X-Api-Key"] = braga_no_limit_key
request_timeout_seconds = 15


def build_rpc_request(req_id, block_num):
    block_hex = hex(block_num)

    payload = {
        "jsonrpc": "2.0",
        "method": "eth_getBlockByNumber",
        "params": [block_hex, False],
        "id": req_id
    }

    return json.dumps(payload).encode("utf-8")


async def send_request(args):
    """Returns the HTTP status code or 'error'."""
    req_id, block_num = args
    parsed_url = urlparse(rpc_url)
    host = parsed_url.hostname
    if host is None:
        return "error"

    is_https = parsed_url.scheme == "https"
    port = parsed_url.port or (443 if is_https else 80)
    path = parsed_url.path or "/"
    if parsed_url.query:
        path = f"{path}?{parsed_url.query}"

    ssl_context = ssl.create_default_context() if is_https else None
    body = build_rpc_request(req_id, block_num)
    request_headers = {
        **headers,
        "Host": host,
        "Content-Length": str(len(body)),
        "Connection": "close",
    }
    header_lines = "\r\n".join(f"{name}: {value}" for name, value in request_headers.items())
    request = f"POST {path} HTTP/1.1\r\n{header_lines}\r\n\r\n".encode("utf-8") + body

    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port, ssl=ssl_context, server_hostname=host if is_https else None),
            timeout=request_timeout_seconds,
        )
        try:
            writer.write(request)
            await asyncio.wait_for(writer.drain(), timeout=request_timeout_seconds)

            status_line = await asyncio.wait_for(reader.readline(), timeout=request_timeout_seconds)
            parts = status_line.decode("iso-8859-1").split(" ", 2)
            if len(parts) < 2:
                return "error"

            return int(parts[1])
        finally:
            writer.close()
            await writer.wait_closed()
    except (OSError, asyncio.TimeoutError, ValueError):
        return "error"


async def run_rate_limit_check(total_requests, start_block):
    # Create the list of arguments: [(0, 10000), (1, 10001), ..., (999, 10999)]
    tasks = [(i, start_block + i) for i in range(total_requests)]

    start_time = time.time()

    # Fire all requests at once using async socket I/O instead of one thread per request.
    results = await asyncio.gather(*(send_request(task) for task in tasks))

    elapsed_time = time.time() - start_time
    return results, elapsed_time


async def main():
    total_requests = 300
    start_block = 10000

    print(f"Starting single-burst rate limit test on {rpc_url}")
    print(f"Spawning {total_requests} concurrent requests for blocks {start_block} to {start_block + total_requests - 1}...\n")

    results, elapsed_time = await run_rate_limit_check(total_requests, start_block)

    # Tally up the results
    success_count = 0
    rate_limit_count = 0
    other_error_count = 0

    for res in results:
        if res == 200:
            success_count += 1
        elif res == 429:
            rate_limit_count += 1
        else:
            other_error_count += 1

    # Print the final report
    print("--- Test Complete ---")
    print(f"Time taken:   {elapsed_time:.3f} seconds")
    print(f"Total fired:  {total_requests}")
    print("-" * 21)
    print(f"✅ Successes (200):     {success_count}")
    print(f"⚠️  Rate Limited (429): {rate_limit_count}")
    print(f"❌ Other Errors:        {other_error_count}")


if __name__ == "__main__":
    asyncio.run(main())
