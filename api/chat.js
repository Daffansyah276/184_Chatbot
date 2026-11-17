function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendStreamError(res, message) {
  res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
}

module.exports = async function chatHandler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Metode tidak diizinkan." });
  }

  const messages = req.body && req.body.messages;
  if (!Array.isArray(messages)) {
    return sendJson(res, 400, { error: "Messages harus berupa array." });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, {
      error: "Environment variable OPENROUTER_API_KEY belum dikonfigurasi."
    });
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "inclusionai/ling-3.2-flash:free",
        messages,
        temperature: 0.7,
        max_tokens: 10000,
        stream: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();

      let upstreamError;
      try {
        upstreamError = JSON.parse(errorText).error;
      } catch {
        upstreamError = null;
      }

      const providerErrorCode = upstreamError &&
        upstreamError.metadata &&
        upstreamError.metadata.provider_error_code;

      if (response.status === 429 || providerErrorCode === "TooManyRequests") {
        console.warn("OpenRouter model is temporarily rate-limited.");
        return sendJson(res, 429, {
          error: "Model AI sedang sibuk karena batas penggunaan tercapai. Coba lagi beberapa saat lagi."
        });
      }

      if (response.status === 401 || response.status === 403) {
        console.error("OpenRouter rejected the API key:", response.status);
        return sendJson(res, response.status, {
          error: "API key OpenRouter ditolak. Periksa environment variable OPENROUTER_API_KEY."
        });
      }

      console.error("OpenRouter request failed:", response.status);
      return sendJson(res, response.status, {
        error: `Layanan AI menolak permintaan (HTTP ${response.status}). Coba lagi nanti.`
      });
    }

    if (!response.body) {
      throw new Error("Layanan AI tidak mengirimkan stream respons.");
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    function processLine(line) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith("data:")) return;

      const data = trimmedLine.slice(5).trim();
      if (!data || data === "[DONE]") return;

      try {
        const event = JSON.parse(data);
        const content = event.choices && event.choices[0] &&
          event.choices[0].delta && event.choices[0].delta.content;

        if (typeof content === "string" && content.length > 0) {
          res.write(`data: ${JSON.stringify(content)}\n\n`);
        } else if (event.error) {
          console.error("OpenRouter stream error:", event.error);
          sendStreamError(res, "Layanan AI gagal membuat respons.");
        }
      } catch (error) {
        console.error("Could not parse OpenRouter stream event:", error);
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (res.destroyed || res.writableEnded) {
          await reader.cancel();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        lines.forEach(processLine);
      }

      buffer += decoder.decode();
      if (buffer.trim()) processLine(buffer);

      if (!res.destroyed && !res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    console.error("Chat handler failed:", error);
    if (res.destroyed || res.writableEnded) return;

    if (res.headersSent) {
      sendStreamError(res, "Terjadi kesalahan saat menghubungi layanan AI.");
      res.end();
    } else {
      sendJson(res, 500, {
        error: "Terjadi kesalahan saat menghubungi layanan AI."
      });
    }
  }
};
