import os
import re
import boto3
import json
import logging
import csv
from io import StringIO

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Create boto3 session and clients
boto3_session = boto3.session.Session()
region = boto3_session.region_name

# Create boto3 clients for Bedrock services
bedrock_agent_runtime_client = boto3.client('bedrock-agent-runtime')
bedrock_client = boto3.client(service_name='bedrock-runtime')

# Get knowledge base ID from environment variable
ops_kb_id = os.environ.get("OPS_KNOWLEDGE_BASE_ID")

# Get number of results for retrival from environment variable or default to 3
num_results = int(os.environ.get("NUM_RESULTS", "5"))

# --- BEGIN: CSV Segment/Model Mapping for RAG Expansion ---
def load_segment_model_mapping_from_s3():
    """
    Loads the segment/model mapping CSV from S3 and returns:
    - model_to_segment: {model_name: segment}
    - segment_to_models: {segment: set([model1, model2, ...])}
    """
    s3_uri = os.environ.get("CITATION_CSV_URI")
    if not s3_uri:
        logger.warning("CITATION_CSV_URI env var not set, skipping segment/model mapping.")
        return None, None
    match = re.match(r'^s3://([^/]+)/(.+)$', s3_uri)
    if not match:
        logger.error(f"Invalid S3 URI format: {s3_uri}")
        return None, None
    bucket, key = match.group(1), match.group(2)
    try:
        s3 = boto3.client('s3')
        obj = s3.get_object(Bucket=bucket, Key=key)
        csv_content = obj['Body'].read().decode('utf-8')
        reader = csv.DictReader(StringIO(csv_content))
        model_to_segment = {}
        segment_to_models = {}
        for row in reader:
            model = row.get('VHCL_MK_MDL_NM')
            segment = row.get('SGMNT_NM')
            if model and segment:
                model = model.strip()
                segment = segment.strip()
                model_to_segment[model] = segment
                segment_to_models.setdefault(segment, set()).add(model)
        logger.info(f"Loaded {len(model_to_segment)} model-to-segment mappings from CSV.")
        return model_to_segment, segment_to_models
    except Exception as e:
        logger.error(f"Error loading segment/model mapping from S3: {e}")
        return None, None

# --- END: CSV Segment/Model Mapping for RAG Expansion ---


_default_model_code_name_mapping = {
    "P42R": "Pathfinder",
    "PZ1D": "Leaf",
    "P33A": "Leaf",
    "SUV" : "Pathfinder",
    "SUV" : "Rogue"
}

def get_contexts(retrievalResults):
    """
    Extract context information from retrieval results
    
    Args:
        retrievalResults: List of results from Bedrock retrieval API
        
    Returns:
        List of context strings for prompt construction
    """
    contexts = []
    video_extensions = {'mp3', 'mp4', 'wav', 'flac', 'ogg', 'amr', 'webm', 'mov'}
    
    for result in retrievalResults:

        # Extract data from S3 URI
        pattern = r'^s3://([^/]+)/(.*/)?([^/]+)$'
        s3_uri = result['location']['s3Location']['uri']
        match = re.match(pattern, s3_uri)
        if not match:
            raise ValueError("Invalid S3 URI format")
        folder_path = match.group(2)[:-1] if match.group(2) else ''
        filename = match.group(3)


        #Removing Documents from the top folder layer to test things.
        folder_path = match.group(2)[:-1] if match.group(2) else ''
        # new: drop top-level "Documents" if present
        if folder_path:
            parts = folder_path.split('/')
            if parts and parts[0].lower() == 'documents':
                folder_path_remove_top_layer = '/'.join(parts[1:])
            else:
                folder_path_remove_top_layer = folder_path
        else:
            folder_path_remove_top_layer = ''
        logger.info(f"Folder path after removing documents folder: {folder_path_remove_top_layer}")

        #filename = result['location']['s3Location']['uri'].split('/')[-1]
        # Get actual extension from filename (part after last underscore, before any dot)
        actual_extension = filename.split('_')[-1].split('.')[0]
        
        source = 'video' if actual_extension in video_extensions else 'file'
        logger.info(f"Adding context from {filename} as {source} type")
        contexts.extend([
            f'<source>{source}</source>',
            f'<location>{folder_path_remove_top_layer}/{filename}</location>',
            #f'<folder>{folder_path}</folder>',
            result['content']['text']
        ])
        # Adding logs to see if Bedrock model returns folder structure.
        uri = result['location']['s3Location']['uri']
        logger.info(f"KB hit URI returned from model: {uri}")
    return contexts

def retrieve_results(query, kb_id):
    """
    Retrieve relevant content from the knowledge base
    
    Args:
        query: User question
        kb_id: Knowledge Base ID
        
    Returns:
        List of context information strings
    """
    model_code_name_mapping = load_model_code_name_mapping_from_s3() or _default_model_code_name_mapping
    # --- BEGIN: Segment/Model Expansion (improved matching) ---
    model_to_segment, segment_to_models = load_segment_model_mapping_from_s3()
    expanded_query = query
    found_model = None
    found_segment = None
    competitor_models = set()
    # Try to find a model in the query (case-insensitive, allow partial matches)
    if model_to_segment:
        logger.info("Searching for models in query from model_to_segment (partial and full matches).")
        query_lower = query.lower()
        # First, try exact (full) match
        for model in model_to_segment:
            if model.lower() in query_lower:
                found_model = model
                found_segment = model_to_segment[model]
                break
        # If not found, try partial match (e.g., 'Rogue' matches 'Nissan - Rogue')
        if not found_model:
            for model in model_to_segment:
                # Split model name on dashes, slashes, and spaces
                model_parts = [part.strip() for part in re.split(r'[-/ ]', model)]
                for part in model_parts:
                    # Only match if part is at least 3 characters and is a whole word in the query
                    if part and len(part) >= 3:
                        # Use regex to match whole word (\b...\b)
                        if re.search(rf'\b{re.escape(part.lower())}\b', query_lower):
                            found_model = model
                            found_segment = model_to_segment[model]
                            logger.info(f"Partial model match: '{part}' in query matches '{model}'")
                            break
                if found_model:
                    break
    # Try to find a segment in the query (case-insensitive, allow partial matches)
    if not found_segment and segment_to_models:
        for segment in segment_to_models:
            if segment.lower() in query.lower():
                found_segment = segment
                logger.info(f"Found segment in query: {segment}")
                break
    # If found, get all models in the same segment
    logger.info(f"Found model: {found_model}, segment: {found_segment}")
    if found_segment and segment_to_models:
        competitor_models = segment_to_models[found_segment]
        if found_model:
            competitor_models = competitor_models - {found_model}
        # Expand the query: add segment and all models in that segment
        expansion_terms = []
        if found_model:
            expansion_terms.append(found_model)
        expansion_terms.append(found_segment)
        expansion_terms += list(competitor_models)
        # Remove duplicates, preserve order
        seen = set()
        expansion_terms = [x for x in expansion_terms if x and not (x in seen or seen.add(x))]
        expanded_query += "\nRelated models and segment: " + ", ".join(expansion_terms)
        logger.info(f"Expanded query with segment and competitors: {expansion_terms}")
    # Also expand with model code/name mapping as before
    for model_code, model_name in model_code_name_mapping.items():
        if (model_code in query) or (model_name in query):
            note = f"(Note: {model_code} refers to {model_name})"
            if note not in expanded_query:
                expanded_query += " " + note

    logger.info(f"Retrieving results for query: {expanded_query}")

    try:
        results = bedrock_agent_runtime_client.retrieve(
            retrievalQuery={
                'text': expanded_query
            },
            knowledgeBaseId=kb_id,
            retrievalConfiguration={
                'vectorSearchConfiguration': {
                    'numberOfResults': num_results,
                    'overrideSearchType': "HYBRID",
                }
            }
        )
        retrieval_results = results['retrievalResults']
        logger.info(f"Retrieved {len(retrieval_results)} results")
        return get_contexts(retrieval_results)
    except Exception as e:
        logger.error(f"Error retrieving results: {e}")
        return ["No relevant content found. Error: " + str(e)]

def generate_conversation(model_id,
                        system_prompts,
                        messages,
                        guardrail_id=None,
                        guardrail_version=None,
                        temperature=None,
                        top_p=None):
    """
    Generate a conversation response using Bedrock model
    
    Args:
        model_id: Bedrock model ID
        system_prompts: System prompt instructions
        messages: User messages
        guardrail_id: Optional guardrail ID
        guardrail_version: Optional guardrail version
        temperature: Optional temperature parameter
        top_p: Optional top_p parameter
        
    Returns:
        Bedrock model response
    """
    logger.info(f"Generating message with model {model_id}")

    # Validate and set default values
    try:
        # Temperature validation: must be float between 0 and 1
        validated_temperature = 0.1  # default
        if temperature is not None:
            temp_float = float(temperature)
            if 0 <= temp_float <= 1:
                validated_temperature = temp_float

        # Top P validation: must be float between 0 and 1
        validated_top_p = 0.9  # default
        if top_p is not None:
            top_p_float = float(top_p)
            if 0 <= top_p_float <= 1:
                validated_top_p = top_p_float

        # Guardrail validation: both id and version must be non-empty strings
        validated_guardrail_id = None
        validated_guardrail_version = None
        if guardrail_id and isinstance(guardrail_id, str) and guardrail_id.strip():
            validated_guardrail_id = guardrail_id.strip()
            if guardrail_version and isinstance(guardrail_version, str) and guardrail_version.strip():
                validated_guardrail_version = guardrail_version.strip()

    except (ValueError, TypeError) as e:
        logger.error(f"Validation error: {str(e)}. Using default values.")
        validated_temperature = 0.1
        validated_top_p = 0.9

    # Base inference parameters
    inference_config = {
        "temperature": validated_temperature,
        "topP": validated_top_p
    }

    # Prepare request parameters
    request_params = {
        "modelId": model_id,
        "messages": messages,
        "system": system_prompts,
        "inferenceConfig": inference_config
    }

    # Add guardrail configuration if ID is provided
    if validated_guardrail_id:
        guardrail_config = {
            "guardrailIdentifier": validated_guardrail_id,
            "trace": "enabled"
        }
        
        # Add version if provided
        if validated_guardrail_version:
            guardrail_config["guardrailVersion"] = validated_guardrail_version
        
        request_params["guardrailConfig"] = guardrail_config

    # Log configuration
    logger.info(f"Using configuration: {json.dumps({
        'temperature': validated_temperature,
        'topP': validated_top_p,
        'guardrailId': validated_guardrail_id,
        'guardrailVersion': validated_guardrail_version,
        'modelId': model_id
    })}")

    # Send the message to Bedrock
    try:
        response = bedrock_client.converse(**request_params)
        
        # Log token usage for monitoring
        token_usage = response['usage']
        logger.info(f"Input tokens: {token_usage['inputTokens']}")
        logger.info(f"Output tokens: {token_usage['outputTokens']}")
        logger.info(f"Total tokens: {token_usage['totalTokens']}")
        logger.info(f"Stop reason: {response['stopReason']}")
        
        return response
    except Exception as e:
        logger.error(f"Error generating conversation: {e}")
        raise

def load_model_code_name_mapping_from_s3():
    s3_uri = os.environ.get("MODELCODE_MODELNAME_MAPPING")
    if not s3_uri:
        logger.warning("MODELCODE_MODELNAME_MAPPING env var not set, using default mapping.")
        return None

    # Parse S3 URI
    match = re.match(r'^s3://([^/]+)/(.+)$', s3_uri)
    if not match:
        logger.error(f"Invalid S3 URI format: {s3_uri}")
        return None
    bucket, key = match.group(1), match.group(2)

    try:
        s3 = boto3.client('s3')
        obj = s3.get_object(Bucket=bucket, Key=key)
        csv_content = obj['Body'].read().decode('utf-8')
        reader = csv.DictReader(StringIO(csv_content))
        mapping = {}
        for row in reader:
            code = row.get('model_code')
            name = row.get('model_name')
            if code and name:
                mapping[code] = name
        logger.info(f"Loaded model_code_name_mapping from S3: {mapping}")
        return mapping
    except Exception as e:
        logger.error(f"Error loading model_code_name_mapping from S3: {e}")
        return None

def lambda_handler(event, context):
    """
    Lambda handler for retrieval and generation
    
    Args:
        event: Lambda event with query and model parameters
        context: Lambda context
    
    Returns:
        Response with answer to user question
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Regex pattern for model ID validation
        model_pattern = r'^(arn:aws(-[^:]+)?:bedrock:[a-z0-9-]{1,20}:((:foundation-model/[a-z0-9-]{1,63}[.]{1}[a-z0-9-]{1,63}([.:]?[a-z0-9-]{1,63}))|([0-9]{12}:provisioned-model/[a-z0-9]{12})|([0-9]{12}:imported-model/[a-z0-9]{12})|([0-9]{12}:application-inference-profile/[a-z0-9]{12})|([0-9]{12}:inference-profile/((([a-z-]{2,8}.)[a-z0-9-]{1,63}[.]{1}[a-z0-9-]{1,63}([.:]?[a-z0-9-]{1,63}))))|([0-9]{12}:default-prompt-router/[a-zA-Z0-9-:.]+)))|(([a-z]{2}[.]{1})([a-z0-9-]{1,63}[.]{1}[a-z0-9-]{1,63}([.:]?[a-z0-9-]{1,63})))|([a-z0-9-]{1,63}[.]{1}[a-z0-9-]{1,63}([.:]?[a-z0-9-]{1,63}))|arn:aws(-[^:]+)?:sagemaker:[a-z0-9-]{1,20}:[0-9]{12}:endpoint/[a-z0-9-]{1,63}$'

        # Get model ID from event or environment
        event_model_id = event.get("modelId")
        if event_model_id and re.match(model_pattern, event_model_id):
            model_id = event_model_id
        else:
            # Fall back to environment variable
            model_id = os.environ.get("MODEL_ID")
            if not model_id:
                raise ValueError("No valid model ID provided")

        # Get query and parameters
        query = event.get("question", "")
        if not query.strip():
            raise ValueError("No question provided")
            
        messages = event.get("messages", [])
        guardrail_id = event.get("guardrailId")
        guardrail_version = event.get("guardrailVersion")
        temperature = event.get("temperature")
        top_p = event.get("topP")
        chat_history = event.get("chatHistory")
        # Retrieve relevant information from knowledge base
        retrieved_info = retrieve_results(query, ops_kb_id)

        # Adding logs to see if Bedrock model returns folder structure.
        logger.info(f"Retrieved info: {retrieved_info}")

        chat_history_context = ""
        if chat_history and isinstance(chat_history, list) and len(chat_history) > 0:
                chat_history_context = "\nPrevious conversation (for context):\n"
                for turn in chat_history:
                        role = turn.get('role', '')
                        content = turn.get('content', '')
                        chat_history_context += f"[{role}] {content}\n"

        # Construct the prompt
        prompt = [{"text": f"""
        You are a question answering agent. The user will provide you with a question. 
        Your job is to answer the user's question using only the following sets of information within <context> </context> tag.
        
        INPUT FORMAT:
        - Each set of information starts with a <source>video</source> or <source>file</source> tag signifying the source
        - Followed by a <location> </location> tag containing a value
        - Information may include timestamps [seconds] and metadata [text] in square brackets
        - Metadata tags examples: [TEXT - Page 0], [PARAGRAPH], [FIGURE - Page X], [LOGO]
        
        RESPONSE FORMAT:
        Part 1 - Answer:
        - MUST be wrapped in <answer> </answer> tags. DO NOT DEVIATE.
        - Should be fluid and natural without unnecessary line breaks
        - YOU MUST remove ALL metadata tags (like [TEXT - Page 0]) from your answer
        - For video sources:
          * You MUST include both location and timestamp in individual square brackets: [timestamp location]
          * Do NOT modify the location value and do NOT remove folder structure from what was provided in <location>location</location>
          * Example: [23 file_mp4.txt] The speaker mentioned AWS is currently..
          * Use ordered lists for multiple points
        
        Part 2 - Location:
        - List ONLY the <location> tags from sources that contributed to your answer.
        - If a <folder> tag exists and is non-empty, combine it with the <location> value using a slash: <location>folder/filename</location>
        - If no <folder> is present, just output the filename: <location>filename</location>
        - One <location> per line. Do not add other text. Each line must have <location> and </location>
        - Each <location></location> tag MUST contain only ONE file. Do NOT place more than one file info in a single 

                
        ERROR HANDLING:
        - If insufficient information is found or you cannot make a conclusion, state that you cannot provide an exact answer and request more context if appropriate. DO NOT add <location> </location> or <answer> </answer> tags

        {chat_history_context}
        Here are the search results:
        <context>
        {retrieved_info}
        </context>
        """}]
        
        #Logging Prompt for debugging
        logger.info(f"Prompt: {prompt}")


        # Generate the response
        response = generate_conversation(
            model_id,
            prompt,
            messages,
            guardrail_id=guardrail_id,
            guardrail_version=guardrail_version,
            temperature=temperature,
            top_p=top_p
        )
        
        #logging response to ensure how AI is working.
        logger.info(f"AI Response: {response}")

        # Get the generated text
        generated_text = response['output']['message']
        logger.info(f'Generated response')
        
        # Return the result
        return {
            'statusCode': 200,
            'body': {"question": query.strip(), "answer": generated_text}
        }
        
    except Exception as e:
        logger.error(f"Error in lambda_handler: {str(e)}", exc_info=True)
        return {
            'statusCode': 500,
            'body': {"question": event.get("question", ""), "answer": f"Error processing your request: {str(e)}"}
        }
