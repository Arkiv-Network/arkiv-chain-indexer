import requests
import time
import concurrent.futures

rpc_url = "https://braga.hoodi.arkiv.network/rpc"
payload = {
    "jsonrpc": "2.0",
    "method": "eth_blockNumber",
    "params": [],
    "id": 1
}
headers = {"Content-Type": "application/json"}

def send_request(req_id):
    """Function to be executed by each thread."""
    try:
        response = requests.post(rpc_url, json=payload, headers=headers, timeout=5)

        if response.status_code == 200:
            res_json = response.json()
            block_hex = res_json.get("result")
            if block_hex:
                block_num = int(block_hex, 16)
                return f"[Req {req_id:03d}] Status: 200 OK | Block: {block_num}"
            else:
                return f"[Req {req_id:03d}] Status: 200 OK | Unexpected response: {res_json}"

        elif response.status_code == 429:
            return f"[Req {req_id:03d}] ⚠️ Status: 429 RATE LIMITED! | Body: {response.text}"
        else:
            return f"[Req {req_id:03d}] Status: {response.status_code} | Body: {response.text}"

    except requests.exceptions.RequestException as e:
        return f"[Req {req_id:03d}] Request failed: {e}"

def run_parallel_batch(batch_num, batch_size=10):
    """Fires a batch of requests in parallel."""
    print(f"\n--- Firing Batch {batch_num} ({batch_size} parallel requests) ---")
    start_time = time.time()

    # ThreadPoolExecutor runs the requests concurrently
    with concurrent.futures.ThreadPoolExecutor(max_workers=batch_size) as executor:
        # Generate unique IDs for this batch's requests
        task_ids = range(batch_num * batch_size, (batch_num + 1) * batch_size)

        # map() automatically starts the threads and waits for all of them to finish
        results = list(executor.map(send_request, task_ids))

        # Print results once the whole batch completes
        for result in results:
            print(result)

    elapsed = time.time() - start_time
    print(f"Batch {batch_num} completed in {elapsed:.3f} seconds.")
    return elapsed

if __name__ == "__main__":
    print(f"Starting parallel rate limit test on {rpc_url}")
    print("Sending bursts of 10 requests every second.")
    print("Press Ctrl+C to stop.\n")

    batch_count = 0
    try:
        while True:
            # Fire 10 requests at the exact same time
            elapsed_time = run_parallel_batch(batch_count, batch_size=100)
            batch_count += 1

            # Calculate how much of the current second is left.
            # If the batch took 0.3 seconds, sleep for 0.7 seconds to hit exactly 1 burst per second.
            sleep_time = max(0, 1.0 - elapsed_time)
            if sleep_time > 0:
                time.sleep(sleep_time)

    except KeyboardInterrupt:
        total_requests = batch_count * 10
        print(f"\nTest stopped. Total batches: {batch_count} (Total requests: {total_requests})")