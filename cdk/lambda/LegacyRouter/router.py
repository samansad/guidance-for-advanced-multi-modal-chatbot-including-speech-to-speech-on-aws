# This was the code when not using SQS queueing.It was Not used as part of final POC.
import json, boto3
import logging

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    logger.info(f"Raw Event: {event}")
    
    try:
        # import your existing worker code in-process
        from index import lambda_handler as worker

        cid   = event["requestContext"]["connectionId"]
        domain= event["requestContext"]["domainName"]
        stage = event["requestContext"]["stage"]
        apigw = boto3.client("apigatewaymanagementapi",
                            endpoint_url=f"https://{domain}/{stage}")

        # If invoked by API Gateway WebSocket, payload arrives under 'body' as text
        if isinstance(event, dict) and "requestContext" in event and "body" in event:
            raw_body = event.get("body")
            if raw_body == "[object Object]":
                raise ValueError("Invalid payload: received '[object Object]'. Client must JSON.stringify before send.")
            if isinstance(raw_body, str) and raw_body.strip():
                try:
                    payload = json.loads(raw_body)
                except json.JSONDecodeError as e:
                    raise ValueError(f"Invalid JSON body: {e.msg}")
        logger.info(f"Updated payload: {payload}")
        # run your existing logic without invoking another Lambda
        result = worker(payload, context)                # returns {"statusCode":..., "body": {...}}
        body   = result.get("body", result)              # body is the JSON you return to the UI

        logger.info(f"Result: {result}")
        logger.info(f"Body: {body}")

        # send reply back over the socket
        apigw.post_to_connection(ConnectionId=cid,
                                Data=json.dumps(body).encode("utf-8"))
        return {"statusCode": 200}
    except Exception as e:
        logger.error(e)
        return {"statusCode": 500}