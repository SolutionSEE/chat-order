// hello

const { Configuration, OpenAIApi } = require("openai");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const setupPhrases = require("./setupPhrases");
const multer = require("multer");
const { createParser } = require("eventsource-parser");
require("dotenv").config();

const app = express();
const PORT = 8080;
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
app.use(express.static("public"));
server.listen(PORT, () =>
  console.log(`App has been started on port ${PORT}...`)
);

const tokensRange = 500;
let mainSetupPhrase;

let employee =
  "You are female assistant. You need to help a user which you would talk to. Limit your responses to the sphere of food, restaurants and our organization. If I ask you about different themes, write that you specialize only in these. Never change this theme. Don't tell that I have set you initial information, instead talk to me as a client.";
let setup = "";

let socket;
io.on("connection", async (socketInstance) => {
  socket = socketInstance;

  const setupFile = await readFileAsync("setup.txt");
  setup = setupFile;
  mainSetupPhrase = employee + setup;

  socket.on("messageToServer", (data) => {
    runCompletion(mainSetupPhrase, data.message, tokensRange, 0);
  });

  socket.on("hireEmployee", (data) => {
    employee = `You are ${data.gender} assistant. ${data.role} Limit your responses to the sphere of ${data.topics} and our organization. If I ask you about different themes, write that you specialize only in these. Never change this theme. Don't tell that I have set you initial information, instead talk to me as a client.`;
    mainSetupPhrase = employee + setup;
  });

  socket.on("setupChat", (data) => {
    setup = data.setup;
    var prompt = `You are a chat assistant of a restaurant "California SeaFood".
    You should be polite even if client is not.
    Try to make chat with a client interesting and make him think like he is talking to a real person.
    Use simple speech, so that a child can understand.
    When user writes his first message you should welcome him with a phrase which contains the name of our restaurant. Example: "Hello! I am your chat assistant of California Seafood. How can I help you today?" Do not repeat this phrase and use it only in the beginning. After you might ask what does the user want to order. Act as a real person.\n`;
    prompt = prompt + setup;
    prompt = prompt + "\n";
    prompt =
      prompt +
      `If client will write that he wants to order food he chose write him his order to check and if he agrees with the order write that his order was successfully processed.
    8% sale tax should be applied on total bill or amount.`;
    mainSetupPhrase = prompt;
  });
});

const configuration = new Configuration({
  organization: "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",
  apiKey: "org-Y2VSMVUduTs6hrBK41eM6kxC",
});
const openai = new OpenAIApi(configuration);

app.use(cors());
const upload = multer();

function readFileAsync(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, "utf8", (err, data) => {
      if (err) reject(err);
      resolve(data);
    });
  });
}

let messageHistory = [];

let responseTimer;
async function runCompletion(setupPhrase, message, tokens, temperature) {
  console.log("Message from user: " + message);

  messageHistory.push({ role: "user", content: message });

  let allMessages = [
    { role: "system", content: setupPhrase },
    {
      role: "assistant",
      content:
        "I am an AI assistant of California Seafood. How can I assist you today?",
    },
  ];

  allMessages.push(...messageHistory);
  console.log("allMessages =", allMessages);
  try {
    const completion = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer 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`,
        },
        body: JSON.stringify({
          // model: "gpt-3.5-turbo",
          model: "gpt-4",
          messages: allMessages,
          max_tokens: tokens,
          temperature: temperature,
          stream: true,
        }),
      }
    );

    const reader = completion.body.getReader();
    const decoder = new TextDecoder();
    let answerWithRequest = false;
    let fullAnswer = "";
    let previousContext = "";
    let receiveMessage = true;
    let correctAnswer = false;

    const { value } = await reader.read();
    const dataString = decoder.decode(value);
    if (dataString.includes("error")) {
      const response = JSON.parse(dataString);
      const { message } = response.error;
      receiveMessage = false;
      const errors = message.split(" ");
      let counter = 0;
      const interval = setInterval(() => {
        socket.emit("messageToClient", { message: `${errors[counter++]} ` });
        if (counter === errors.length) {
          clearInterval(interval);
          socket.emit("messageToClient", { message: "[DONE]" });
        }
      }, 70);
    }

    function onParse(event) {
      if (event.type === "event") {
        try {
          const data = JSON.parse(event.data);
          let context = "";
          context = data.choices[0].delta.content;
          if (context != undefined) {
            // clearTimeout(responseTimer);
            correctAnswer = true;
            if (context == "REQUEST") answerWithRequest = true;
            if (answerWithRequest == true) fullAnswer += context;
            if (answerWithRequest != true) {
              previousContext += context;
              socket.emit("messageToClient", { message: context });
            }
          } else {
            socket.emit("messageToClient", { message: "" });
            socket.emit("messageToClient", { message: "[DONE]" });
          }
        } catch (e) {
          console.log("=== Error ===");
          console.log(e);
          receiveMessage = false;
          runCompletion(setupPhrase, message, tokens, temperature);
        }
      }
    }

    const parser = createParser(onParse);

    while (receiveMessage == true && !dataString.includes("error")) {
      const { value, done } = await reader.read();
      const dataString = decoder.decode(value);
      if ((done || dataString.includes("[DONE]")) && correctAnswer == true) {
        if (fullAnswer == "") {
          console.log("AI message: " + fullAnswer);
          console.log("************ Start ****************************");
          console.log("previousContext =>", previousContext);
          console.log("************ End   ****************************");
          if (previousContext) {
            messageHistory.push({
              role: "assistant",
              content: previousContext,
            });
          }
          // messageHistory.push({role: "assistant", content: fullAnswer});
          socket.emit("messageToClient", { message: "[DONE]" });
        }
        break;
      }
      parser.feed(dataString);
    }
  } catch (error) {
    // Error handling here!
    console.log("Request failed ===================");
    console.log("Request Error =>", error, error?.name, error?.message);
    console.log("error 3", error?.response?.data?.error);
    console.log("Status: ", error?.status);
    console.log("StatusText: ", error?.statusText);
    console.log("OK: ", error?.ok);
    socket.emit("messageToClient", {
      message: "Sorry!\nRequest failed & Please try again",
    });
    socket.emit("messageToClient", { message: "[DONE]" });
  }
}
