//evals.ts

import { EvalConfig } from 'mcp-evals';
import { openai } from "@ai-sdk/openai";
import { grade, EvalFunction } from "mcp-evals";

const sendEmailEval: EvalFunction = {
    name: "send-email Tool Evaluation",
    description: "Evaluates the send-email tool's functionality",
    run: async () => {
        const result = await grade(openai("gpt-4"), "Please send an email from 'sender@example.com' to 'recipient@example.com' with the subject 'Tool Test' and text body 'Hello from the tool!'");
        return JSON.parse(result);
    }
};

const config: EvalConfig = {
    model: openai("gpt-4"),
    evals: [sendEmailEval]
};
  
export default config;
  
export const evals = [sendEmailEval];