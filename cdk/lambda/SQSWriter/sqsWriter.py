# This lambda function is triggered by API Gateway WebSocket events.
# It writes the WebSocket connection information and message content to an SQS queue for further processing.
import json
import boto3
import os
import logging

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize SQS client
sqs = boto3.client('sqs')

def lambda_handler(event, context):
    """
    Lambda function triggered by API Gateway WebSocket
    Writes WebSocket connection info and message to SQS
    """
    try:
        logger.info(f"Received event: {event}")
        # Get SQS queue URL from environment variable
        queue_url = os.environ.get('SQS_QUEUE_URL')
        if not queue_url:
            logger.error("SQS_QUEUE_URL environment variable not set")
            return {
                'statusCode': 500,
                'body': json.dumps({'error': 'SQS queue URL not configured'})
            }
        
        # Extract WebSocket connection info
        connection_id = event['requestContext']['connectionId']
        route_key = event['requestContext']['routeKey']
        domain_name = event['requestContext']['domainName']
        stage = event['requestContext']['stage']
        
        # Extract message body
        message_body = event.get('body', '')
        if message_body:
            try:
                # Try to parse as JSON if possible
                parsed_body = json.loads(message_body)
            except json.JSONDecodeError:
                # Keep as string if not valid JSON
                parsed_body = message_body
        else:
            parsed_body = {}
        
        # Prepare message for SQS
        sqs_message = {
            'websocket_info': {
                'connection_id': connection_id,
                'route_key': route_key,
                'domain_name': domain_name,
                'stage': stage,
                'endpoint_url': f"https://{domain_name}/{stage}"
            },
            'message_info': {
                'body': parsed_body,
                'timestamp': context.aws_request_id,
                'request_id': context.aws_request_id
            },
            'event_context': {
                'source_ip': event['requestContext'].get('sourceIp', ''),
                'user_agent': event['requestContext'].get('userAgent', ''),
                'request_time': event['requestContext'].get('requestTime', '')
            }
        }
        
        # Send message to SQS
        response = sqs.send_message(
            QueueUrl=queue_url,
            MessageBody=json.dumps(sqs_message),
            MessageAttributes={
                'ConnectionId': {
                    'StringValue': connection_id,
                    'DataType': 'String'
                },
                'RouteKey': {
                    'StringValue': route_key,
                    'DataType': 'String'
                }
            }
        )
        
        logger.info(f"Message sent to SQS: {response['MessageId']}")
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Thinking...',
                'messageId': response['MessageId']
            })
        }
        
    except Exception as e:
        logger.error(f"Error processing WebSocket message: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': 'Internal server error',
                'details': str(e)
            })
        }