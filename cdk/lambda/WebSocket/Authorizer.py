# This is a custom authorizer for AWS API Gateway using Cognito User Pools
import os, json, boto3

cidp = boto3.client("cognito-idp", region_name=os.environ.get("COGNITO_REGION","us-east-1"))

def lambda_handler(event, context):
    token = (event.get("queryStringParameters") or {}).get("auth")
    if not token:
        return deny("anonymous", event["methodArn"])

    try:
        user = cidp.get_user(AccessToken=token)  # validates token and expiry
        sub = next((a["Value"] for a in user["UserAttributes"] if a["Name"]=="sub"), "unknown")
        return allow(sub, event["methodArn"])     # required IAM policy shape
    except Exception:
        return deny("anonymous", event["methodArn"])

def allow(principal, resource):  return policy(principal, "Allow", resource)
def deny(principal, resource):   return policy(principal, "Deny", resource)

def policy(principal, effect, resource):
    return {
      "principalId": principal,
      "policyDocument": {
        "Version": "2012-10-17",
        "Statement": [{"Action":"execute-api:Invoke","Effect":effect,"Resource":resource}]
      },
      # optional context for your backend
      "context": {"sub": principal}
    }