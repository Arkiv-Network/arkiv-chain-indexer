import requests
import time
import concurrent.futures

rpc_url = "https://braga.hoodi.arkiv.network/rpc"
headers = {"Content-Type": "application/json"}

def send_request(args):
    """Function executed by each thread. Returns the status code or 'error'."""
    req_id, block_num = args
    block_hex = hex(block_num)

    payload = {
        "jsonrpc": "2.0",
        "method": "eth_getBlockByNumber",
        "params": [block_hex, False],
        "id": req_id
    }

    try:
        # Increased timeout since 1000 local threads can cause local queuing delays
        response = requests.post(rpc_url, json=payload, headers=headers, timeout=15)
        return response.status_code

    except requests.exceptions.RequestException as e:
        return "error"

if __name__ == "__main__":
    total_requests = 1000
    start_block = 10000

    print(f"Starting single-burst rate limit test on {rpc_url}")
    print(f"Spawning {total_requests} concurrent requests for blocks {start_block} to {start_block + total_requests - 1}...\n")

    # Create the list of arguments: [(0, 10000), (1, 10001), ..., (999, 10999)]
    tasks = [(i, start_block + i) for i in range(total_requests)]

    start_time = time.time()

    # Fire all 1000 at once
    # Note: 1000 threads is quite high for Python, but usually fine for simple I/O blocking.
    with concurrent.futures.ThreadPoolExecutor(max_workers=total_requests) as executor:
        results = list(executor.map(send_request, tasks))

    elapsed_time = time.time() - start_time

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