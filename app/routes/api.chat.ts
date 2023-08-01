import { Configuration, OpenAIApi } from "openai-edge"
import { ActionArgs, ActionFunction, Session } from "@remix-run/node"
import {
  functions,
  systemPrompt,
  articulationPrompt,
  critiquePrompt,
  ValuesCardCandidate,
} from "~/lib/consts"
import { ChatCompletionRequestMessage } from "openai-edge"
import { OpenAIStream, StreamingTextResponse } from "../lib/openai-stream"
import { capitalize } from "~/utils"
import { auth, db } from "~/config.server"

// import { OpenAIStream, StreamingTextResponse } from "ai"   TODO replace the above import with this once https://github.com/vercel-labs/ai/issues/199 is fixed.

export const runtime = "edge"

const model = "gpt-4-0613"

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
})

const openai = new OpenAIApi(configuration)

export type ArticulateCardFunction = {
  name: string
  arguments: {}
}

export type SubmitCardFunction = {
  name: string
  arguments: {
    title: string
    instructions_short: string
    instructions_detailed: string
  }
}

/**
 * A function declaration for a virtual function that outputs a values cards JSON.
 */
const formatCard = {
  name: "submit",
  description:
    "Submit an articulated values card based on a source of meaning.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "The title of the values card.",
      },
      instructions_short: {
        type: "string",
        description:
          "A short instruction for how ChatGPT could act based on this source of meaning.",
      },
      instructions_detailed: {
        type: "string",
        description:
          "A detailed instruction for how ChatGPT could act based on this source of meaning.",
      },
      evaluation_criteria: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "A list of things to attend to that can be used to evaluate whether ChatGPT is following this source of meaning.",
      },
    },
    required: [
      "title",
      "instructions_short",
      "instructions_detailed",
      "evaluation_criteria",
    ],
  },
}

//
// Vercel AI openai functions handling is broken in Remix. The `experimental_onFunctionCall` provided by the `ai` package does not work.
//
// We have to handle them manually, until https://github.com/vercel-labs/ai/issues/199 is fixed.
// This is done by listening to the first token and seeing if it is a function call.
// If so, wait for the whole response and handle the function call.
// Otherwise, return the stream as-is.
//
async function getFunctionCall(
  res: Response
): Promise<ArticulateCardFunction | SubmitCardFunction | null> {
  const stream = OpenAIStream(res.clone()) // .clone() since we don't want to consume the response.
  const reader = stream.getReader()

  //
  // In the case of a function call, the first token in the stream
  // is an unfinished JSON object, with "function_call" as the first key.
  //
  // We can use that key to check if the response is a function call.
  //
  const { value: first } = await reader.read()

  const isFunctionCall = first
    ?.replace(/[^a-zA-Z0-9_]/g, "")
    ?.startsWith("function_call")

  if (!isFunctionCall) {
    return null
  }

  //
  // Function arguments are streamed as tokens, so we need to
  // read the whole stream, concatenate the tokens, and parse the resulting JSON.
  //
  let result = first

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    result += value
  }

  //
  // Return the resulting function call.
  //
  const json = JSON.parse(result)["function_call"]

  // This is needed due to tokens being streamed with escape characters.
  json["arguments"] = JSON.parse(json["arguments"])

  return json as ArticulateCardFunction | SubmitCardFunction
}

/** Critique a values card and return an updated version in the format of the official schema. */
async function critiqueValuesCard(
  valuesCard: ValuesCardCandidate
): Promise<ValuesCardCandidate> {
  console.log("Critiquing values card...")
  console.log(`Card before critique:\n${JSON.stringify(valuesCard)}`)

  //
  // Critique the card and return a structured JSON response
  // by using a virtual "submit_critique" function.
  //
  const res = await openai.createChatCompletion({
    model,
    messages: [
      { role: "system", content: critiquePrompt },
      { role: "user", content: JSON.stringify(valuesCard) },
    ],
    functions: [
      {
        name: "submit_critique",
        description: "Critique a values card submitted by the user.",
        parameters: {
          type: "object",
          properties: {
            initial_card: formatCard.parameters,
            revised_card: formatCard.parameters,
            critique: {
              type: "string",
              description: "Critique of the initial card.",
            },
          },
          required: ["initial_card", "critique", "revised_card"],
        },
      },
    ],
    function_call: {
      name: "submit_critique",
    },
    temperature: 0.0,
    stream: false,
  })

  const json = await res.json()
  const data = JSON.parse(json.choices[0].message.function_call.arguments) as {
    initial_card: ValuesCardCandidate
    revised_card: ValuesCardCandidate
    critique: string
  }

  console.log(`Critique: ${data.critique}`)
  console.log(`Card after critique:\n${JSON.stringify(data.revised_card)}`)

  return data.revised_card
}

/** Create a values card from a transcript of the conversation. */
async function articulateValuesCard(
  messages: ChatCompletionRequestMessage[]
): Promise<ValuesCardCandidate> {
  console.log("Articulating values card...")

  const transcript = messages
    .filter((m) => m.role === "assistant" || m.role === "user")
    .map((m) => `${capitalize(m.role)}: ${m.content}`)
    .join("\n")

  const res = await openai.createChatCompletion({
    model,
    messages: [
      { role: "system", content: articulationPrompt },
      { role: "user", content: transcript },
    ],
    functions: [formatCard],
    function_call: { name: formatCard.name },
    temperature: 0.0,
    stream: false,
  })

  const data = await res.json()
  const card = JSON.parse(data.choices[0].message.function_call.arguments)
  return await critiqueValuesCard(card)
}

async function submitValuesCard(
  card: ValuesCardCandidate,
  chatId: string
): Promise<string> {
  console.log(`Submitting values card:\n\n${JSON.stringify(card)}`)

  // Save the card in the database.
  await db.valuesCard
    .create({
      data: {
        title: card.title,
        instructionsShort: card.instructions_short,
        instructionsDetailed: card.instructions_detailed,
        evaluationCriteria: card.evaluation_criteria,
        chatId,
      },
    })
    .catch((e) => console.error(e))

  return `<the values card (´${card.title}) was submitted. The user has now submitted 1 value in total. Proceed to thank the user for submitting their value.>`
}

async function createHeaders(
  session: Session,
  articulatedCard?: ValuesCardCandidate | null,
  submittedCard?: ValuesCardCandidate | null
): Promise<{ [key: string]: string }> {
  const headers: { [key: string]: string } = {
    "Set-Cookie": await auth.storage.commitSession(session),
  }

  if (articulatedCard) {
    headers["X-Articulated-Card"] = JSON.stringify(articulatedCard)
  }

  if (submittedCard) {
    headers["X-Submitted-Card"] = JSON.stringify(submittedCard)
  }

  return headers
}

/** Call the right function and return the resulting stream. */
async function streamingFunctionCallResponse(
  func: ArticulateCardFunction | SubmitCardFunction,
  messages: any[] = [],
  session: Session,
  chatId: string
): Promise<StreamingTextResponse> {
  //
  // Call the right function.
  //
  let result: string = ""
  let articulatedCard: ValuesCardCandidate | null = null
  let submittedCard: ValuesCardCandidate | null = null

  switch (func.name) {
    case "articulate_values_card": {
      // Articulate the values card.
      articulatedCard = await articulateValuesCard(messages)

      // Save the card in the session.
      session.set("values_card", JSON.stringify(articulatedCard))

      result = `<A card (${articulatedCard.title}) was articulated and shown to the user. The preview of the card is shown in the UI, no need to repeat it here. The user can now choose to submit the card.>`
      break
    }
    case "submit_values_card": {
      // Get the values card from the session.
      if (!session.has("values_card")) {
        throw Error("No values card in session")
      }

      submittedCard = JSON.parse(
        session.get("values_card")
      ) as ValuesCardCandidate

      // Submit the values card.
      result = await submitValuesCard(submittedCard, chatId)

      // Update the session.
      session.unset("values_card")

      break
    }
    default: {
      throw new Error("Unknown function call: " + func.name)
    }
  }

  console.log(`Result from "${func.name}":\n${result}`)

  //
  // Call the OpenAI API with the function result.
  //
  // This wraps the raw function result in a generated message that fits the flow
  // of the conversation.
  //
  const res = await openai.createChatCompletion({
    model,
    messages: [
      ...messages,
      {
        role: "assistant",
        content: null,
        function_call: {
          name: func.name,
          arguments: JSON.stringify(func.arguments), // API expects a string.
        },
      },
      {
        role: "function",
        name: func.name,
        content: result,
      },
    ],
    temperature: 0.0,
    functions,
    function_call: "none", // Prevent recursion.
    stream: true,
  })

  return new StreamingTextResponse(OpenAIStream(res), {
    headers: await createHeaders(session, articulatedCard, submittedCard),
  })
}

export const action: ActionFunction = async ({
  request,
}: ActionArgs): Promise<Response> => {
  const session = await auth.storage.getSession(request.headers.get("Cookie"))
  const userId = await auth.getUserId(request)
  const json = await request.json()

  let { messages, chatId } = json

  // Prepend the system message.
  messages = [{ role: "system", content: systemPrompt }, ...messages]

  // Save the transcript in the database.
  await db.chat
    .upsert({
      where: { id: chatId },
      update: { transcript: messages },
      create: {
        id: chatId,
        transcript: messages,
        userId,
      },
    })
    .catch((e) => console.error(e))

  // Create stream for next chat message.
  const res = await openai.createChatCompletion({
    model,
    messages: messages,
    temperature: 0.7,
    stream: true,
    functions,
    function_call: "auto",
  })

  if (!res.ok) {
    const body = await res.json()
    throw body.error
  }

  // If a function call is present in the stream, handle it...
  const func = await getFunctionCall(res)
  if (func) {
    return streamingFunctionCallResponse(func, messages, session, chatId)
  }

  // ...otherwise, return the response.
  return new StreamingTextResponse(OpenAIStream(res), {
    headers: await createHeaders(session),
  })
}