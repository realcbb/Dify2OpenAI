// workflowHandler.js

import fetch from "node-fetch";
import { PassThrough } from "stream";
import FormData from "form-data";
import { log } from '../config/logger.js';
import { logApiCall, generateId, getFileExtension, getFileType } from "./utils.js";

// 上传文件到 Dify，获取文件 ID
async function uploadFileToDify(base64Data, config, userId) {
  try {
    // 解析 base64 数据 URL，提取 contentType 和 base64 字符串
    const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error("Invalid base64 data");
    }
    let contentType = matches[1];
    const base64String = matches[2];
    let fileData = Buffer.from(base64String, "base64");

    // 如果 contentType 是 'image/jpg'，将其调整为 'image/jpeg'
    if (contentType === "image/jpg") {
      contentType = "image/jpeg";
    }

    // 从 contentType 确定文件扩展名
    const fileExtension = contentType.split("/")[1]; // 例如 'jpeg'、'png'、'gif'

    // 创建文件名
    const filename = `file.${fileExtension}`;

    // 创建 FormData 并包含 'user' 字段
    const form = new FormData();
    // 确保 fileData 是 Buffer 类型
    if (typeof fileData === 'string') {
      fileData = Buffer.from(fileData);
    }

    // 尝试直接使用 Buffer，如果失败则转换为 base64 字符串
    try {
      form.append("file", fileData, {
        filename: filename,
        contentType: contentType,
      });
      log("debug", "使用 Buffer 上传文件", { userId });
    } catch (e) {
      log("warn", "Buffer 上传失败，尝试使用 base64 字符串", {
        error: e.message,
        requestId: userId,
      });
      form.append("file", fileData.toString('base64'), {
        filename: filename,
        contentType: contentType,
      });
    }

    form.append("user", userId); // 使用提供的用户标识符

    // 记录文件上传请求的详细信息
    log("info", "正在上传文件到 Dify", {
      url: `${config.DIFY_API_URL}/files/upload`,
      headers: {
        Authorization: `Bearer ${config.API_KEY}`,
        ...form.getHeaders(),
      },
      formData: "<<FILE DATA>>", // 出于安全考虑，不记录实际文件数据
    });

    // 发送上传请求
    const response = await fetch(`${config.DIFY_API_URL}/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    // 记录文件上传响应的详细信息
    log("info", "文件上传响应", {
      status: response.status,
      statusText: response.statusText,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      log("error", "文件上传失败", {
        status: response.status,
        statusText: response.statusText,
        errorBody: errorBody,
      });
      throw new Error(
        `文件上传失败: ${response.status} ${response.statusText}: ${errorBody}`
      );
    }

    const result = await response.json();
    log("info", "文件上传成功", { fileId: result.id });
    return result.id; // 返回文件 ID
  } catch (error) {
    console.error("上传文件出错:", error);
    throw error;
  }
}

// 处理 Workflow 类型请求
async function handleRequest(req, res, config, requestId, startTime) {
  try {
    const apiPath = "/workflows/run";
    const data = req.body;
    const messages = data.messages;
    let inputs = {};
    let files = [];

    // 记录收到的请求头和请求体
    log("info", "收到请求", {
      requestId,
      headers: req.headers,
      body: data,
    });

    // 优先使用 config.USER，然后是请求中的 user，最后是默认值
    const userId = config.USER || data.user || "apiuser";
    const lastMessage = messages[messages.length - 1];
    
    // 第一步：先扫描所有消息中的图片内容
    log("info", "开始扫描所有消息中的图片", { requestId, messageCount: messages.length });
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        for (const content of message.content) {
          if (content.type === "image_url" && content.image_url && content.image_url.url) {
            const imageUrl = content.image_url.url;
            
            // 检查URL是否为base64数据
            if (imageUrl.startsWith('data:')) {
              // 是base64数据，需要上传
              const fileExt = getFileExtension(imageUrl);
              const fileType = getFileType(fileExt);
              log("info", "检测到base64数据，准备上传", { requestId, fileType, fileExt });
              const fileId = await uploadFileToDify(
                imageUrl,
                config,
                userId
              );
              // 构建输入格式
              const fileInput = {
                transfer_method: "local_file",
                upload_file_id: fileId,
                type: fileType,
              };
              // file_input 必须是数组
              if (!inputs["file_input"]) {
                inputs["file_input"] = [];
              }
              inputs["file_input"].push(fileInput);
            } else {
              // 是真正的URL，直接使用remote_url方式
              const fileExt = getFileExtension(imageUrl);
              const fileType = getFileType(fileExt);
              log("info", "检测到远程文件URL", { requestId, url: imageUrl.substring(0, 30) + '...', fileType, fileExt });
              const fileInput = {
                transfer_method: "remote_url",
                url: imageUrl,
                type: fileType,
              };
              // file_input 必须是数组
              if (!inputs["file_input"]) {
                inputs["file_input"] = [];
              }
              inputs["file_input"].push(fileInput);
            }
          }
        }
      }
    }
    
    // 第二步：从消息中提取系统提示和用户查询文本
    let systemPrompt = "";
    let userQuery = "";

    // 提取系统消息（role为system的消息）
    for (const message of messages) {
      if (message.role === "system") {
        if (Array.isArray(message.content)) {
          for (const content of message.content) {
            if (typeof content === "string") {
              systemPrompt += content + "\n";
            } else if (content.type === "text") {
              systemPrompt += content.text + "\n";
            }
          }
        } else {
          systemPrompt += message.content + "\n";
        }
      }
    }

    // 正确提取用户查询文本：扫描所有消息，找到用户文本内容
    log("info", "开始提取用户查询文本", {
      requestId,
      messageCount: messages.length
    });

    for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
      const message = messages[msgIndex];
      if (message.role === "user") {
        if (Array.isArray(message.content)) {
          for (let i = 0; i < message.content.length; i++) {
            const content = message.content[i];

            // 处理字符串类型的内容（OpenAI格式）
            if (typeof content === "string") {
              userQuery += content + "\n";
            }
            // 处理对象类型的内容
            else if (content && content.type === "text" && typeof content.text === "string") {
              userQuery += content.text + "\n";
            }
            // 处理其他类型的内容（记录但不添加到查询）
            // else {
            //   log("warn", "跳过不支持的内容类型", {
            //     requestId,
            //     messageIndex: msgIndex,
            //     contentIndex: i,
            //     contentType: typeof content,
            //     contentObj: content
            //   });
            // }
            // 注意：这里不再重复处理image_url，因为已经在上面处理过了
          }
        } else {
          // 处理非数组类型的内容
          if (typeof message.content === "string") {
            userQuery += message.content + "\n";
          } else {
            // log("warn", "不支持的 content 类型", {
            //   requestId,
            //   messageIndex: msgIndex,
            //   contentType: typeof message.content,
            //   content: message.content
            // });
            userQuery += String(message.content) + "\n";
            log("debug", "转换为字符串并添加到 userQuery", {
              requestId,
              messageIndex: msgIndex,
              convertedContent: String(message.content),
              currentQuery: userQuery
            });
          }
        }
      }
    }
    userQuery = userQuery.trim(); // 去除末尾的换行符

    log("info", "完成用户查询文本提取", {
      requestId,
      finalUserQuery: userQuery,
      queryLength: userQuery.length,
      isEmpty: !userQuery || userQuery.trim().length === 0
    });

    // 设置输入变量
    systemPrompt = systemPrompt.trim();
    userQuery = userQuery.trim();

    // 如果存在 SYSTEM_INPUT_VARIABLE，则分别设置系统提示和用户查询
    if (config.SYSTEM_INPUT_VARIABLE && systemPrompt) {
      inputs[config.SYSTEM_INPUT_VARIABLE] = systemPrompt;
      log("debug", "设置系统提示", {
        requestId,
        systemInputKey: config.SYSTEM_INPUT_VARIABLE,
        systemPrompt
      });
    }

    // 设置用户查询
    const inputVariable = config.INPUT_VARIABLE || "text_input";
    inputs[inputVariable] = userQuery;

    log("info", "设置用户查询到 inputs", {
      requestId,
      inputVariable,
      userQuery: userQuery,
      userQueryLength: userQuery.length,
      inputsAfterUserQuery: inputs
    });

    // 如果没有分离的系统提示词，但有系统消息，则将其添加到用户查询前面
    if (!config.SYSTEM_INPUT_VARIABLE && systemPrompt) {
      inputs[inputVariable] = systemPrompt + "\n\n" + userQuery;
      log("info", "合并系统提示和用户查询", {
        requestId,
        inputVariable,
        systemPrompt,
        userQuery,
        finalInput: inputs[inputVariable],
        inputsAfterMerge: inputs
      });
    }

    // 日志记录
    log("info", "处理 Workflow 类型消息", {
      requestId,
      inputs,
      files,
    });

    const stream = data.stream !== undefined ? data.stream : false;

    // 构建请求体
    const requestBody = {
      inputs: inputs,
      response_mode: stream ? "streaming" : "blocking",
      user: userId,
      files: files, // 如果需要，可以将 files 数组添加到请求体中
    };

    // 记录将要发送到 Dify 的请求载荷
    log("info", "发送请求到 Dify", {
      requestId,
      url: config.DIFY_API_URL + apiPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.API_KEY}`,
      },
      body: requestBody,
    });

    // 发送请求到 Dify
    const resp = await fetch(config.DIFY_API_URL + apiPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    // 记录 API 调用时间
    const apiCallDuration = Date.now() - startTime;
    logApiCall(requestId, config, apiPath, apiCallDuration);

    // 记录 Dify 的响应状态
    log("info", "收到 Dify 响应", {
      requestId,
      status: resp.status,
      statusText: resp.statusText,
    });

    if (!resp.ok) {
      const errorBody = await resp.text();
      log("error", "Dify API 请求失败", {
        requestId,
        status: resp.status,
        statusText: resp.statusText,
        errorBody: errorBody,
      });
      res.status(resp.status).send(errorBody);
      return;
    }

    // 记录响应头信息
    log("info", "Dify 响应头信息", {
      requestId,
      headers: Object.fromEntries(resp.headers.entries()),
      contentType: resp.headers.get('content-type'),
    });

    let isResponseEnded = false;

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      let buffer = "";
      const responseStream = resp.body
        .pipe(new PassThrough())
        .on("data", (chunk) => {
          buffer += chunk.toString();
          let lines = buffer.split("\n");

          for (let i = 0; i < lines.length - 1; i++) {
            let line = lines[i].trim();

            if (!line.startsWith("data:")) continue;
            line = line.slice(5).trim();
            let chunkObj;
            try {
              if (line.startsWith("{")) {
                chunkObj = JSON.parse(line);
              } else {
                continue;
              }
            } catch (error) {
              console.error("解析 chunk 出错:", error);
              continue;
            }

            // 记录每个 chunk 的内容
            log("debug", "处理 chunk", {
              requestId,
              chunkObj,
            });

            if (chunkObj.event === "workflow_started") {
              // 处理 workflow_started 事件
            } else if (chunkObj.event === "node_started") {
              // 处理 node_started 事件
            } else if (chunkObj.event === "node_finished") {
              // 处理 node_finished 事件
            } else if (chunkObj.event === "workflow_finished") {
              const outputs = chunkObj.data.outputs;
              let result;
              if (config.OUTPUT_VARIABLE) {
                result = outputs[config.OUTPUT_VARIABLE];
              } else {
                result = outputs;
              }

              const chunkId = `chatcmpl-${Date.now()}`;
              const chunkCreated = chunkObj.created_at;
              if (!isResponseEnded) {
                res.write(
                  "data: " +
                    JSON.stringify({
                      id: chunkId,
                      object: "chat.completion.chunk",
                      created: chunkCreated,
                      model: data.model,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            content: result,
                          },
                          finish_reason: "stop",
                        },
                      ],
                    }) +
                    "\n\n"
                );
                res.write("data: [DONE]\n\n");
                res.end();
                isResponseEnded = true;
              }
            } else if (chunkObj.event === "ping") {
              // 处理 ping 事件
            } else if (chunkObj.event === "error") {
              console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
              res
                .status(500)
                .write(
                  `data: ${JSON.stringify({ error: chunkObj.message })}\n\n`
                );

              if (!isResponseEnded) {
                res.write("data: [DONE]\n\n");
              }

              res.end();
              isResponseEnded = true;
            }
          }

          buffer = lines[lines.length - 1];
        });

      // 记录响应结束
      responseStream.on("end", () => {
        log("info", "响应结束", { requestId });
      });
    } else {
      let result = "";
      let usageData = "";
      let buffer = "";
      let hasError = false;

      // 记录普通响应开始
      log("info", "开始处理普通响应", {
        requestId,
        timestamp: new Date().toISOString(),
      });

      // 检查是否是直接的 JSON 响应（blocking 模式）
      const contentType = resp.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        // 直接解析 JSON 响应
        const jsonData = await resp.json();
        log("info", "收到 JSON 响应", {
          requestId,
          data: jsonData,
        });

        if (jsonData.data && jsonData.data.outputs) {
          const outputs = jsonData.data.outputs;
          if (config.OUTPUT_VARIABLE) {
            result = outputs[config.OUTPUT_VARIABLE];
            log("info", "提取指定的 OUTPUT_VARIABLE", {
              requestId,
              OUTPUT_VARIABLE: config.OUTPUT_VARIABLE,
              result,
            });
          } else {
            result = outputs;
            log("info", "使用整个 outputs 对象", {
              requestId,
              result,
            });
          }
          usageData = {
            total_tokens: jsonData.data.total_tokens || 110,
          };
        }

        // 发送响应
        const formattedResponse = {
          id: `chatcmpl-${generateId()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: data.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: result,
              },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
          usage: usageData,
          system_fingerprint: "fp_2f57f81c11",
        };

        res.set("Content-Type", "application/json");
        res.json(formattedResponse);
        logApiCall(requestId, config, apiPath, Date.now() - startTime);
        return;
      }

      // 否则按流式处理
      const responseStream = resp.body;
      responseStream.on("data", (chunk) => {
        buffer += chunk.toString();
        let lines = buffer.split("\n");

        log("debug", "收到响应数据", {
          requestId,
          chunkText: chunk.toString().substring(0, 200),
          bufferLength: buffer.length,
        });

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (line === "") continue;
          let chunkObj;
          try {
            const cleanedLine = line.replace(/^data: /, "").trim();
            if (cleanedLine.startsWith("{") && cleanedLine.endsWith("}")) {
              chunkObj = JSON.parse(cleanedLine);
            } else {
              log("debug", "跳过非JSON行", {
                requestId,
                line: line.substring(0, 100),
              });
              continue;
            }
          } catch (error) {
            log("error", "解析 JSON 出错", {
              requestId,
              error: error.message,
              line: line.substring(0, 100),
            });
            continue;
          }

          // 记录每个 chunk 的内容
          log("debug", "处理 chunk", {
            requestId,
            chunkObj,
          });

          if (chunkObj.event === "workflow_finished") {
            const outputs = chunkObj.data.outputs;
            log("info", "收到 workflow_finished 事件", {
              requestId,
              outputs,
              OUTPUT_VARIABLE: config.OUTPUT_VARIABLE,
            });

            if (config.OUTPUT_VARIABLE) {
              result = outputs[config.OUTPUT_VARIABLE];
              log("info", "提取指定的 OUTPUT_VARIABLE", {
                requestId,
                OUTPUT_VARIABLE: config.OUTPUT_VARIABLE,
                result,
                resultType: typeof result,
              });
            } else {
              result = outputs;
              log("info", "使用整个 outputs 对象", {
                requestId,
                result,
              });
            }
            usageData = {
              total_tokens: chunkObj.data.total_tokens || 110,
            };
          } else if (chunkObj.event === "ping") {
            // 处理 ping 事件
          } else if (chunkObj.event === "error") {
            hasError = true;
            console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
            break;
          }
        }

        buffer = lines[lines.length - 1];
      });

      responseStream.on("end", () => {
        if (hasError) {
          res
            .status(500)
            .json({ error: "An error occurred while processing the request." });
        } else {
          const formattedResponse = {
            id: `chatcmpl-${generateId()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: data.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: result,
                },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
            usage: usageData,
            system_fingerprint: "fp_2f57f81c11",
          };
          const jsonResponse = JSON.stringify(formattedResponse, null, 2);

          // 记录发送的响应
          log("info", "发送响应", {
            requestId,
            response: formattedResponse,
          });

          res.set("Content-Type", "application/json");
          res.send(jsonResponse);
        }
      });
    }
  } catch (error) {
    console.error("处理 Workflow 请求时发生错误:", error);

    // 记录错误
    log("error", "处理 Workflow 请求时发生错误", {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    res.status(500).json({ error: error.message });
  }
}

export default {
  handleRequest,
};
