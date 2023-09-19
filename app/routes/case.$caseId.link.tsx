import { Button } from "~/components/ui/button"
import Header from "~/components/header"
import { useLoaderData, useNavigate, useParams } from "@remix-run/react"
import { LoaderArgs, json } from "@remix-run/node"
import { auth, db } from "~/config.server"
import ValuesCard from "~/components/values-card"
import { useEffect, useState } from "react"
import toast from "react-hot-toast"
import LinkingService from "~/services/linking"
import { Configuration, OpenAIApi } from "openai-edge"
import EmbeddingService from "~/services/embedding"
import { IconArrowRight } from "~/components/ui/icons"
import { Separator } from "../components/ui/separator"
import { Loader2 } from "lucide-react"
import StaticChatMessage from "~/components/static-chat-message"
import { cn } from "~/utils"
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group"
import { Label } from "~/components/ui/label"
import { Textarea } from "~/components/ui/textarea"

type Relationship = "upgrade" | "no_upgrade" | "not_sure"

export async function loader({ request, params }: LoaderArgs) {
  const userId = await auth.getUserId(request)
  const caseId = params.caseId!

  const config = new Configuration({ apiKey: process.env.OPENAI_API_KEY })
  const openai = new OpenAIApi(config)
  const embedding = new EmbeddingService(openai, db)
  const service = new LinkingService(db, embedding)

  const draw = await service.getDraw(userId, caseId, 3)

  return json({ draw })
}

export async function action({ request }: LoaderArgs) {
  const userId = await auth.getUserId(request)
  const body = await request.json()
  const { edge, comment, relationship } = body

  console.log(
    `Submitting edge from ${edge.from.id} to ${edge.to.id} as ${relationship}`
  )

  await db.edge.upsert({
    where: {
      userId_fromId_toId: {
        userId,
        fromId: edge.from.id,
        toId: edge.to.id,
      },
    },
    create: {
      userId,
      toId: edge.to.id,
      fromId: edge.from.id,
      story: edge.story,
      runId: edge.runId,
      relationship,
      comment,
    },
    update: {
      story: edge.story,
      runId: edge.runId,
      relationship,
      comment,
    },
  })

  return json({})
}

export default function LinkScreen() {
  const navigate = useNavigate()

  const { caseId } = useParams()

  const [index, setIndex] = useState<number>(0)
  const [showCards, setShowCards] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [relationship, setRelationship] = useState<Relationship | null>(null)
  const [comment, setComment] = useState<string | null>(null)

  const { draw } = useLoaderData<typeof loader>()

  // If there are no values in the draw, continue to next step.
  useEffect(() => {
    if (draw.length === 0) {
      navigate("/finished")
    }
  }, [draw])

  const onContinue = async () => {
    setIsLoading(true)

    const body = {
      edge: draw[index],
      relationship,
      comment,
    }

    const response = await fetch(`/case/${caseId}/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      setIsLoading(false)
      const text = await response.json()
      console.error(text)
      toast.error("Failed to submit relationship. Please try again.")
      return
    }

    // If we're at the end of the draw, navigate to the finish screen.
    if (index === draw.length - 1) {
      return navigate("/finished")
    }

    setRelationship(null)
    setIsLoading(false)
    setComment(null)

    // Move to the next pair.
    setIndex((i) => i + 1)
  }

  if (!draw[index]) {
    return (
      <div className="h-screen w-screen flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen w-screen">
      <Header />
      <div className="grid place-items-center space-y-4 py-12 px-8">
        <h1 className="text-neutral-500 mb-2">{`User Story ${index + 1}/${
          draw.length
        }`}</h1>
        <StaticChatMessage
          onFinished={() => {
            setShowCards(true)
          }}
          isFinished={showCards}
          text={'"' + draw[index].story + '"'}
          role="user"
        />
        <div
          className={cn(
            `grid grid-cols-1 md:grid-cols-3 mx-auto gap-4 items-center justify-items-center md:grid-cols-[max-content,min-content,max-content] mb-4`,
            "transition-opacity ease-in duration-500",
            showCards ? "opacity-100" : "opacity-0",
            `delay-${75}`
          )}
        >
          <ValuesCard card={draw[index].from as any} />
          <IconArrowRight className="h-8 w-8 mx-auto rotate-90 md:rotate-0" />
          <ValuesCard card={draw[index].to as any} />
        </div>
        <div
          className={cn(
            `w-full flex items-center justify-center py-8`,
            "transition-opacity ease-in duration-500",
            showCards ? "opacity-100" : "opacity-0",
            `delay-${125}`
          )}
        >
          <Separator className="max-w-2xl" />
        </div>
        <div
          className={cn(
            "transition-opacity ease-in duration-500 flex flex-col items-center justify-center w-full max-w-xs",
            showCards ? "opacity-100" : "opacity-0",
            `delay-${150}`
          )}
        >
          <h1 className="font-bold mr-auto">
            Did this person make a value upgrade?
          </h1>
          <RadioGroup
            key={relationship}
            className="w-full"
            value={relationship ?? undefined}
            onValueChange={(r) => setRelationship(r as Relationship)}
          >
            <div className="flex flex-col space-y-2  w-full space-between mt-4">
              <div className="flex items-center space-x-2">
                <RadioGroupItem value={"upgrade"} id="yes" />
                <Label htmlFor="yes">Yes</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="no_upgrade" id="no" />
                <Label htmlFor="no">No</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="not_sure" id="not_sure" />
                <Label htmlFor="not_sure">Not Sure</Label>
              </div>
            </div>
          </RadioGroup>

          <div className="grid w-full max-w-sm items-center gap-2 mt-8">
            <Label htmlFor="comment">Why?</Label>
            <Textarea
              id="comment"
              disabled={!relationship}
              className="bg-white"
              onChange={(e) => setComment(e.target.value)}
              value={comment ?? ""}
              placeholder="Add your reasoning"
            />
          </div>

          <div className="mt-8">
            <Button disabled={!relationship || isLoading} onClick={onContinue}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {draw.length - index === 1 ? "Finish" : "Continue"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
