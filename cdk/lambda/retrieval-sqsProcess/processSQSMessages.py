# This Lambda receives the message from SQS, work with BedRock to get the response, and write the response into WebSocket.
import json, boto3
import logging

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    logger.info(f"Raw Event: {event}")

    try:
        from index import lambda_handler as worker

        # SQS event: event["Records"] is a list
        for record in event.get("Records", []):
            raw_body = record.get("body")
            payload = json.loads(raw_body)

            logger.info(f"Updated payload: {payload}")
            # Extract connection info from payload
            cid    = payload["websocket_info"]["connection_id"]
            domain = payload["websocket_info"]["domain_name"]
            stage  = payload["websocket_info"]["stage"]
            apigw  = boto3.client("apigatewaymanagementapi",
                                  endpoint_url=f"https://{domain}/{stage}")

            result = worker(payload['message_info']['body'], context)
            body   = result.get("body", result)

            logger.info(f"Result: {result}")
            logger.info(f"Body: {body}")

            apigw.post_to_connection(ConnectionId=cid,
                                     Data=json.dumps(body).encode("utf-8"))
        return {"statusCode": 200}
    except Exception as e:
        logger.error(e)
        return {"statusCode": 500}