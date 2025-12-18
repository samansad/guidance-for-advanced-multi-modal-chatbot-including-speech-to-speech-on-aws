# This function handles the connection event for a WebSocket API in AWS API Gateway.
import json
import logging

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

def lambda_handler(event, context):
    # TODO implement
    logger.info(f"Event: {event}")
    logger.info(f"Context: {context}")
    return {
        'statusCode': 200
    }