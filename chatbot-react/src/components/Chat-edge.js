import React, { useState, useRef, useEffect, Suspense } from 'react';
import { Auth } from 'aws-amplify';
import { getCloudFrontDomain } from '../config/amplify-config';
import VideoPopover from './VideoPopover-edge';
import FormField from "@cloudscape-design/components/form-field";
import ChatBubble from "@cloudscape-design/chat-components/chat-bubble";
import Avatar from "@cloudscape-design/chat-components/avatar";
import './Chat.css';
import PromptInput from "@cloudscape-design/components/prompt-input";
import { Button, Toggle } from "@cloudscape-design/components";
import { useGuardrail, useInferenceConfig } from '../context/AppContext';
import S2SManager from './helper/S2SManager';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Set of valid media extensions
const MEDIA_EXTENSIONS = new Set(['mp2', 'mp3', 'mp4', 'wav', 'flac', 'ogg', 'amr', 'webm', 'mov']);

const key = Object.keys(localStorage).find(
  k => k.startsWith('CognitoIdentityServiceProvider.') && k.endsWith('.userData')
);

const userEmail = key ? JSON.parse(localStorage.getItem(key)).UserAttributes.find(attr => attr.Name === 'email').Value : null;
console.log('User email from Cognito:', userEmail);




// Utility function to convert time
const convertTime = (stime) => {
  if (!stime) return '';
  
  // Remove XML tags if present
  const cleanTime = stime.replace(/<\/?timestamp>/g, '');
  
  // Check if the string contains any numbers
  if (!(/\d/.test(cleanTime))) {
    return cleanTime;
  }

  // If cleanTime is not a number, return as is
  if (isNaN(cleanTime)) {
    return cleanTime;
  }

  const totalSeconds = parseInt(cleanTime);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  // If hours > 0, return HH:MM:SS format, otherwise return MM:SS
  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

const parseMetadata = (metadataLines) => {
  const parsed = {};
  
  metadataLines.forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('<location>')) {
      const location = trimmedLine.replace(/<\/?location>/g, '');
      parsed[location] = []; 
    }
  });

  return parsed;
};

const parseTimestamps = (answer, parsedMetadata) => {
  // Replace [time filename] as before, and also handle [filename] (no time)
  let result = answer.replace(/\[([\d\-]+)\s+([^\]]+)\]/g, (match, seconds, filename) => {
    if (Object.keys(parsedMetadata).includes(filename)) {
      //const actual_extension = filename.split('_').pop().split('.')[0];
      const parts = filename.split('.');
      const actual_extension = parts.length > 1 ? parts[parts.length - 2] : '';
      if (MEDIA_EXTENSIONS.has(actual_extension)) {
        // If seconds is a range, use the first value
        const firstSeconds = seconds.includes('-') ? seconds.split('-')[0] : seconds;
        const formattedTime = convertTime(firstSeconds);
        return `|||TIMESTAMP:${seconds}:${formattedTime}:${filename}|||`;
      } else {
        return '';
      }
    }
    return match;
  });
  // Now handle [filename] (no time) for known media files in metadata
  result = result.replace(/\[([^\[\]\s]+)\]/g, (match, filename) => {
    if (Object.keys(parsedMetadata).includes(filename)) {
      //const actual_extension = filename.split('_').pop().split('.')[0];
      const parts = filename.split('.');
      const actual_extension = parts.length > 1 ? parts[parts.length - 2] : '';
      if (MEDIA_EXTENSIONS.has(actual_extension)) {
        // Just show the filename, no brackets
        return filename;
      }
    }
    return match;
  });
  return result;
};

const getFileUrl = async (filename) => {
  if (filename) {
    //const actual_extension = filename.split('_').pop().split('.')[0];
    const parts = filename.split('.');
    const actual_extension = parts.length > 1 ? parts[parts.length - 2] : '';
    const baseFileName = filename.split('.')[0].replace(`_${actual_extension}`, '').replace(/ /g, '%20');
    console.log('Fetching URL for: Filename:', filename, '  Base Filename:', baseFileName, '  Extension:', actual_extension);
    try {
      const session = await Auth.currentSession();
      const token = session.getIdToken().getJwtToken();
      return {
        url: `https://${getCloudFrontDomain()}.cloudfront.net/${baseFileName}.${actual_extension}?auth=${encodeURIComponent(token)}`,
        token: token
      };
    } catch (error) {
      console.error('Error getting authentication token:', error);
      return null;
    }
  }
  return '';
};

const AsyncVideoPopover = ({ filename, seconds, displayTime, getFileUrl }) => {
  const [videoData, setVideoData] = useState(null);

  useEffect(() => {
    getFileUrl(filename).then(data => {
      if (data) {
        setVideoData(data);
      }
    });
  }, [filename]);

  if (!videoData) return displayTime;

  return (
    <VideoPopover
      videoUrl={videoData.url}
      timestamp={seconds}
      displayTime={displayTime}
    />
  );
};

const Chat = () => {
  // Handler for New Chat button
  const instructionsMessage = {
    role: 'info',
    content: `This platform provides access to insights from past MI field research\ncovering three key studies:\n**- Product Competitiveness Clinic (PCC)**\n**- Marcom Communication Strategy Study (MCSS)**\n**- Product Quality After Launch Review (PQ-ALR)**\n\nThe solution focuses on three vehicles: \n**Rogue (P33A; 2018-2021), Pathfinder (P42R; 2018-2021), and Leaf (PZ1D – ALR excluded; 2022-2023)**\nUse this tool to search and extract insights from available datasets—including presentations, transcripts, videos, and spreadsheets—to support efficient and productive decision-making.\n\nSample Prompts:\n**Based on videos only what do people think of Pathfinder?**\n**Can you tell me all points in customer interviews where potential customers express what they want from their next vehicle?**`
  };
  const handleNewChat = () => {
    setMessages([instructionsMessage]);
    sessionStorage.removeItem('chatSession');
  };
  const [messages, setMessages] = useState([]);
  // Show instructions on page load (not sent to backend, not saved in chatSession)
  useEffect(() => {
    setMessages([instructionsMessage]);
  }, []);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [parsedMetadata, setParsedMetadata] = useState({});
  const [copiedMessageId, setCopiedMessageId] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState(false);  
  const messagesEndRef = useRef(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const isSpeechSupported = 'speechSynthesis' in window;  
  const { guardrailValue, guardrailVersion } = useGuardrail();
  const { temperature, topP, modelId } = useInferenceConfig();
  
  // S2S specific state
  const [useS2S, setUseS2S] = useState(false);
  const [s2sAlert, setS2sAlert] = useState(null);
  const [lastResponseId, setLastResponseId] = useState(null); // Track the last response ID
  const [processingResponse, setProcessingResponse] = useState(false); // Debounce flag
  const [lastUserMessageId, setLastUserMessageId] = useState(null); // Track the last user message ID
  const [lastTranscriptionTime, setLastTranscriptionTime] = useState(0); // Track when we last received a transcription
  
  // S2S refs
  const audioPlayerRef = useRef(null);
  const s2sManagerRef = useRef(null);

  //Adding for WebSocket
  const [ws, setWs] = useState(null);
  const wsRef = useRef(null);

  // Initialize S2S manager
  useEffect(() => {
    s2sManagerRef.current = new S2SManager({
      onTranscription: (text) => {
        // Update the input field with the current transcription
        setInput(text);
      },
      onUserMessage: (text) => {
        // Generate a unique ID for this user message
        const messageId = `user_${Date.now()}`;
        
        // Check if this is a new message or an update to an existing one
        const now = Date.now();
        const timeSinceLastTranscription = now - lastTranscriptionTime;
        
        // Update the timestamp
        setLastTranscriptionTime(now);
        
        // Replace the generic "Starting voice conversation..." message with the actual transcription
        setMessages(prev => {
          // Find the last user message
          const lastUserMessageIndex = [...prev].reverse().findIndex(msg => msg.role === 'user');
          
          if (lastUserMessageIndex !== -1) {
            // Convert from reverse index to actual index
            const actualIndex = prev.length - 1 - lastUserMessageIndex;
            
            // If the last user message is the generic one, or if it's a recent transcription, replace it
            if (prev[actualIndex].content === "Starting voice conversation..." || 
                timeSinceLastTranscription < 3000) { // 3 seconds threshold
              
              // Update existing user message
              const newMessages = [...prev];
              newMessages[actualIndex] = {
                role: 'user',
                content: text,
                id: messageId
              };
              
              // Update the last user message ID
              setLastUserMessageId(messageId);
              
              return newMessages;
            }
          }
          
          // If we didn't replace anything, add as a new message
          setLastUserMessageId(messageId);
          
          return [...prev, {
            role: 'user',
            content: text,
            id: messageId
          }];
        });
      },
      onResponse: (text) => {
        // Generate a unique ID for this response based on content
        const responseId = `${text.substring(0, 20)}_${Date.now()}`;
        
        // Check if we're already processing a response or if this is a duplicate
        if (processingResponse || responseId === lastResponseId) {
          return;
        }
        
        // Set processing flag to prevent rapid additions
        setProcessingResponse(true);
        
        // Add a small delay to debounce multiple rapid responses
        setTimeout(() => {
          setMessages(prev => {
            // Check if we already have this message
            const isDuplicate = prev.some(msg => 
              msg.role === 'assistant' && msg.content === text
            );
            
            if (isDuplicate) {
              return prev;
            }
            
            // Otherwise add the new message
            return [...prev, { 
              role: 'assistant', 
              content: text,
              id: responseId // Store the ID with the message
            }];
          });
          
          // Update the last response ID
          setLastResponseId(responseId);
          
          // Reset processing flag
          setProcessingResponse(false);
        }, 100); // Small delay to debounce
      },
      onError: (error) => {
        setS2sAlert(error);
      },
      onStateChange: (isActive) => {
        setIsRecording(isActive);
      }
    });
    
    return () => {
      if (s2sManagerRef.current && s2sManagerRef.current.isSessionActive()) {
        s2sManagerRef.current.endSession();
      }
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (pendingSubmit && input.trim()) {
      handleSubmit();
      setPendingSubmit(false);
    }
  }, [pendingSubmit, input]);
  
  // Set audio player ref for S2S
  useEffect(() => {
    if (audioPlayerRef.current && s2sManagerRef.current) {
      s2sManagerRef.current.setAudioPlayerRef(audioPlayerRef.current);
    }
  }, [audioPlayerRef.current, s2sManagerRef.current]);

  // Added for WebSocket
  // Initialize WebSocket connection
  useEffect(() => {
    /*const socket = new window.WebSocket(process.env.REACT_APP_WEBSOCKET_URL);
    wsRef.current = socket;
    setWs(socket);*/
    console.log('Setting up WebSocket connection...');
    const setupSocket = async () => {
      console.log('Fetching auth token for WebSocket...');
      const session = await Auth.currentSession();
      const accessToken = session.getAccessToken().getJwtToken();
      const url = `${process.env.REACT_APP_WEBSOCKET_URL}?auth=${encodeURIComponent(accessToken)}`;
      const socket = new WebSocket(url);
      wsRef.current = socket;
      setWs(socket);

      socket.onopen = () => {
        console.log("WebSocket connected");
      };

      socket.onmessage = (event) => {
        try {
          let data = event.data;
          console.log('WebSocket message received:', data);
          // Try to parse as JSON if possible
          //try { data = JSON.parse(event.data); } catch (_) {}

          const result = JSON.parse(data);
          let content;
          content = result.answer.content[0].text;
          console.log('Extracted content:', content);
          content = content.replace(/\\n/g, '\n');
          console.log('Content after newline replacement:', content);
          saveToSession('assistant', content);
          if (content.includes('</answer>')) {
            const [answerText, metadataText] = content.split('<answer>')[1].split('</answer>');
            console.log('Answer Text:', answerText);
            console.log('Metadata Text:', metadataText);
            // Check for location tags within answer
            let processedAnswer = answerText;
            let locationTags = '';
            if (answerText.includes('<location>')) {
              // FIXED: Correct regex for location tag
              const locationMatch = answerText.match(/<location>(.*?)<\/location>/s);
              if (locationMatch) {
                locationTags = `<location>${locationMatch[1]}</location>`;
                processedAnswer = answerText.replace(/<location>.*?<\/location>/s, '').trim();
                console.log('Extracted location tags:', locationTags);
                console.log('Processed answer without location tags:', processedAnswer);
              }
            }
            // Combine metadata with location tags
            const combinedMetadata = locationTags ? `${locationTags}\n${metadataText}` : metadataText;

            const metadata = parseMetadata(combinedMetadata.split('\n'));
            setParsedMetadata(metadata);
            let parsedAnswer = parseTimestamps(answerText, metadata);
            // Improved Markdown numbered list fix: only join lines that are part of a numbered list item, but preserve other formatting.
            // This version only joins lines that are indented or start with whitespace after a numbered list header.
            parsedAnswer = parsedAnswer.replace(/(\d+\.\s+\*\*[^\n]+\*\*:\s*)([\s\S]*?)(?=\n\d+\.|$)/g, (match, header, body) => {
              // Only join lines that are indented (start with space/tab) or empty, otherwise keep as is
              const lines = body.split(/\n/);
              const joined = lines.map((line, idx) => {
                if (idx === 0) return line.trim();
                // Only join if line is indented or empty
                if (/^\s/.test(line) || line.trim() === '') {
                  return line.trim();
                } else {
                  // If not indented, treat as a new paragraph (keep newline)
                  return '\n' + line.trim();
                }
              }).join(' ');
              return `${header}${joined}\n`;
            });

            setMessages(prev => [...prev, { 
              role: 'assistant', 
              content: parsedAnswer.replace(/\n/g, '\n').replace(/\"/g, '"'),
              metadata: metadata // if available
            }]);
          } else {
            // Handle content without answer tags but possibly with location tags
            let processedContent = content;
            if (content.includes('<location>')) {
              // FIXED: Correct regex for location tag
              processedContent = content.replace(/<location>.*?<\/location>/s, '').trim();
            }

            setMessages(prev => [...prev, { 
              role: 'assistant', 
              content: processedContent.replace(/\\n/g, '\n').replace(/\\"/g, '"') 
            }]);
          }
        } catch (error) {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: `Error parsing socket message: ${error.message}\nRaw: ${event.data}`
          }]);
        }
      };

      socket.onerror = (err) => {
        console.error('WebSocket error:', err);
      };

      /*socket.onclose = () => {
        console.log('WebSocket closed');
      };*/
      socket.onclose = (e) => console.error("WS closed", e.code, e.reason);
      return () => {
        socket.close();
      };
    };
    setupSocket();
  }, []);

  const startListening = () => {
    if (useS2S) {
      if (s2sManagerRef.current) {
        if (s2sManagerRef.current.isSessionActive()) {
          s2sManagerRef.current.endSession();
        } else {
          // Add user message to chat
          setMessages(prev => [...prev, { 
            role: 'user', 
            content: "Starting voice conversation..." 
          }]);
          s2sManagerRef.current.startSession();
        }
      }
    } else {
      if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        const recognition = new SpeechRecognition();
        
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'en-US';
    
        recognition.onstart = () => {
          setIsRecording(true);
        };
    
        recognition.onresult = (event) => {
          const transcript = event.results[0][0].transcript;
          setInput(transcript);
          setTimeout(() => {
            setPendingSubmit(true);
          }, 1500);
        };
    
        recognition.onerror = (event) => {
          setIsRecording(false);
        };
    
        recognition.onend = () => {
          setIsRecording(false);
        };
    
        try {
          recognition.start();
        } catch (error) {
          console.error('Error starting speech recognition:', error);
        }
      } else {
        alert('Speech recognition is not supported in this browser.');
      }
    }
  };

  const speak = (text) => {
    // Cancel any ongoing speech
    window.speechSynthesis.cancel();
  
    const utterance = new SpeechSynthesisUtterance(text);

    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    
    // Optional: Customize the voice settings
    utterance.rate = 1.0;  // Speed of speech (0.1 to 10)
    utterance.pitch = 1.0; // Pitch (0 to 2)
    utterance.volume = 1.0; // Volume (0 to 1)
    
    // Optional: Select a specific voice
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(voice => voice.lang === 'en-US');
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }
  
    window.speechSynthesis.speak(utterance);
  };

  const stopSpeaking = () => {
    window.speechSynthesis.cancel();
  };
  
  const handleSubmit = async () => {
    if (!input.trim()) return;

    const userMessage = input.trim();
    setInput('');
    setIsLoading(true);

    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);

    // Get chat history from sessionStorage
    let chatHistory = [];
    try {
      const stored = sessionStorage.getItem('chatSession');
      if (stored) {
        chatHistory = JSON.parse(stored);
      }
    } catch {}

    const payload = {
      question: userMessage,
      messages: [{
        role: 'user',
        content: [{ text: userMessage }]
      }],
      guardrailId: guardrailValue,
      guardrailVersion: guardrailVersion,
      temperature: temperature,
      topP: topP,
      chatHistory: chatHistory.length > 0 ? chatHistory : undefined,
      userEmail: userEmail
    };
    console.log('Payload to be sent:', payload);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    } else {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'WebSocket is not connected. Please try again.'
      }]);
    }
    saveToSession('user', userMessage);
    setIsLoading(false);
  };

  function saveToSession(role, content) {
    const key = 'chatSession';
    let chat = [];
    try {
      chat = JSON.parse(sessionStorage.getItem(key)) || [];
    } catch {}
    chat.push({ role, content });
    sessionStorage.setItem(key, JSON.stringify(chat));
  }

  return (
    <div className="chat-container">
      <div className="chat-header" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
        <Button onClick={handleNewChat} variant="normal">New Chat</Button>
        {/* Assuming you have a Sign Out button elsewhere, place this beside it. If not, add it here as needed. */}
      </div>
      <div className="messages">
        {messages.map((message, index) => (
          <div key={index}>
            {message.role === 'user' ? (
              <ChatBubble
                type="outgoing"
                avatar={
                  <Avatar
                    ariaLabel="User"
                    tooltipText="User"
                    initials="U"
                  />
                }
              >
                {message.content}
              </ChatBubble>
            ) : message.role === 'info' ? (
              <ChatBubble
                type="incoming"
                avatar={
                  <Avatar
                    color="gen-ai"
                    iconName="gen-ai"
                    ariaLabel="Info"
                    tooltipText="Info"
                  />
                }
              >
                <div className="custom-message-content">
                  <ReactMarkdown>{message.content}</ReactMarkdown>
                </div>
              </ChatBubble>
            ) : (
              <ChatBubble
                type="incoming"
                avatar={
                  <Avatar
                    color="gen-ai"
                    iconName="gen-ai"
                    ariaLabel="Assistant"
                    tooltipText="Assistant"
                  />
                }
              >
                <div className="custom-message-content">
                  {/* If no timestamp marker, render whole message as Markdown (with tables support) */}
                  {!message.content.includes('|||') ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                  ) : (
                    message.content.split('|||').map((part, partIndex) => {
                      if (part.startsWith('TIMESTAMP:')) {
                        const content = part.substring('TIMESTAMP:'.length);
                        const firstSplit = content.indexOf(':');
                        const seconds = content.substring(0, firstSplit);
                        const remaining = content.substring(firstSplit + 1);
                        const lastColonIndex = remaining.lastIndexOf(':');
                        const displayTime = remaining.substring(0, lastColonIndex);
                        const filename = remaining.substring(lastColonIndex + 1);
                        //const actual_extension = filename?.split('_').pop().split('.')[0];
                        const parts = filename.split('.');
                        const actual_extension = parts.length > 1 ? parts[parts.length - 2] : '';
                        if (message.metadata && MEDIA_EXTENSIONS.has(actual_extension)) {
                          return (
                            <Suspense key={`inline-${partIndex}`} fallback={displayTime}>
                              <AsyncVideoPopover
                                filename={filename}
                                seconds={parseInt(seconds)}
                                displayTime={displayTime}
                                getFileUrl={getFileUrl}
                              />
                            </Suspense>
                          );
                        }
                        return displayTime;
                      }
                      // For text parts, render as Markdown (with tables support)
                      return <ReactMarkdown key={`text-${partIndex}`} remarkPlugins={[remarkGfm]}>{part}</ReactMarkdown>;
                    })
                  )}
                  {message.role === 'assistant' && isSpeechSupported && (
                    <button 
                      onClick={() => isSpeaking ? stopSpeaking() : speak(message.content)}
                      style={{
                        marginLeft: '8px',
                        padding: '4px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer'
                      }}
                    >
                      {isSpeaking ? '🔇' : '🔊'}
                    </button>
                  )}
                  {message.metadata && Object.keys(message.metadata).length > 0 && (
                    <div className="additional-content">
                      {Object.keys(message.metadata).map((location, metaIndex) => {
                          if (location) {
                            // Determine extension and baseFileName based on file type
                            let url = '';
                            let fileNameWithExt = '';
                            const lastDot = location.lastIndexOf('.');
                            const ext = lastDot !== -1 ? location.substring(lastDot + 1).toLowerCase() : '';
                            // Special handling for media files named like ..._ext.txt
                            //let mediaMatch = location.match(/(.+)_([a-z0-9]+)\.txt$/i);
                            let mediaMatch = location.match(/(.+)\.([a-z0-9]+)\.txt$/i);
                            if (mediaMatch && MEDIA_EXTENSIONS.has(mediaMatch[2].toLowerCase())) {
                              // e.g. .../Day 2 group 3_mp2.txt => .../Day 2 group 3.mp2
                              const baseFileName = mediaMatch[1];
                              const actualExtension = mediaMatch[2];
                              url = `https://${getCloudFrontDomain()}.cloudfront.net/${encodeURIComponent(baseFileName)}.${actualExtension}`;
                              fileNameWithExt = `${baseFileName}.${actualExtension}`;
                            } else if (MEDIA_EXTENSIONS.has(ext)) {
                              // Media file with direct extension
                              url = `https://${getCloudFrontDomain()}.cloudfront.net/${encodeURIComponent(location)}`;
                              fileNameWithExt = location;
                            } else if (ext === 'txt') {
                              // Check if it's a transcript (e.g. .pdf.txt, .docx.txt, etc.)
                              const beforeTxt = location.substring(0, lastDot);
                              const secondLastDot = beforeTxt.lastIndexOf('.');
                              const transcriptExt = secondLastDot !== -1 ? beforeTxt.substring(secondLastDot + 1).toLowerCase() : '';
                              // List of common document extensions
                              const DOC_EXTS = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'rtf', 'odt', 'ods', 'odp'];
                              if (DOC_EXTS.includes(transcriptExt)) {
                                // It's a transcript, strip .txt only
                                url = `https://${getCloudFrontDomain()}.cloudfront.net/${encodeURIComponent(beforeTxt)}`;
                                fileNameWithExt = beforeTxt;
                              } else {
                                // It's a plain .txt file
                                url = `https://${getCloudFrontDomain()}.cloudfront.net/${encodeURIComponent(location)}`;
                                fileNameWithExt = location;
                              }
                            } else {
                              // Other file types
                              url = `https://${getCloudFrontDomain()}.cloudfront.net/${encodeURIComponent(location)}`;
                              fileNameWithExt = location;
                            }
                            const tryOpenDocument = async () => {
                              try {
                                const session = await Auth.currentSession();
                                const token = session.getIdToken().getJwtToken();
                                const encodedToken = encodeURIComponent(token);
                                const urlWithAuth = `${url}?auth=${encodedToken}`;
                                window.open(urlWithAuth, '_blank', 'noopener');
                              } catch (error) {
                                console.error('Error:', error);
                                alert('Error opening content: ' + error.message);
                              }
                            };
                            return (
                              <div key={`content-${metaIndex}`} className="know-more-section">
                                <Button onClick={tryOpenDocument}>
                                  {`Know More (${fileNameWithExt})`}
                                </Button>
                              </div>
                            );
                          }
                          return null;
                        })}
                    </div>
                  )}
                </div>
              </ChatBubble>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="input-container">
        <FormField
          stretch={true}
          constraintText={
            <>Character count: {input.length}</>
          }
        >
          <form onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) {
              handleSubmit();
            }
          }}>
            <div className="input-wrapper">
              <div className="prompt-input-container">
                <PromptInput
                  value={input}
                  onChange={({ detail }) => setInput(detail.value)}
                  placeholder="Ask a question..."
                  disabled={isLoading || (useS2S && isRecording)}
                  loading={isLoading}
                  expandToViewport
                  actionButtonAriaLabel="Send message"
                  actionButtonIconName="send"
                />
              </div>
              <div className="microphone-button-container">
                <Button
                  iconName={isRecording ? "microphone-off" : "microphone"}
                  variant="icon"
                  onClick={startListening}
                  loading={isRecording}
                  disabled={isLoading}
                  ariaLabel={isRecording ? "Stop recording" : "Start recording"}
                />
              </div>
              <div className="s2s-toggle-container" style={{ marginLeft: '10px' }}>
                <Toggle
                  onChange={({ detail }) => {
                    setUseS2S(detail.checked);
                    // If turning off S2S while it's active, end the session
                    if (!detail.checked && s2sManagerRef.current && s2sManagerRef.current.isSessionActive()) {
                      s2sManagerRef.current.endSession();
                    }
                  }}
                  checked={useS2S}
                >
                  S2S
                </Toggle>
              </div>
            </div>
          </form>
        </FormField>
        {/* Hidden audio player for S2S */}
        <audio ref={audioPlayerRef} style={{ display: 'none' }}></audio>
        {s2sAlert && (
          <div className="s2s-alert" style={{ marginTop: '10px', color: 'red' }}>
            {s2sAlert}
          </div>
        )}
      </div>
    </div>
  );
};

export default Chat;
