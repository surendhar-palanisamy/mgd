import { Prisma } from "@prisma/client"
import { LoaderArgs, json } from "@remix-run/node"
import { db } from "~/config.server"
import { prolificRuns } from "~/lib/consts"

interface Politics {
  summary: {
    affiliation?: "republican" | "democrat" | "independent"
    affiliationPercentage?: number
  }
  counts: {
    democrat: number
    republican: number
    independent: number
  }
}

export interface VoteStatistics {
  valueId: number
  votes: number
  impressions: number
  votePercentage: number
  politics?: Politics
}

function calculatePolitics(demographics: any[]): Politics | undefined {
  // Filter out votes with too little signal.
  if (demographics.length < 3) {
    return undefined
  }

  const politics = demographics.reduce(
    (acc, val) => {
      if (!val) return acc
      const aff = val.usPoliticalAffiliation.toLowerCase()
      if (aff === "republican") {
        acc.counts.republican++
      } else if (aff === "democrat") {
        acc.counts.democrat++
      }
      return acc
    },
    { counts: { republican: 0, democrat: 0, independent: 0 } }
  ) as Politics

  const counts = politics.counts
  counts.independent = demographics.length - counts.republican - counts.democrat

  if (counts.republican > counts.democrat) {
    politics.summary = {
      affiliation: "republican",
      affiliationPercentage: counts.republican / demographics.length,
    }
  } else if (
    counts.democrat > counts.republican
  ) {
    politics.summary = {
      affiliation: "democrat",
      affiliationPercentage: counts.democrat / demographics.length,
    }
  }

  return politics
}

export async function loader({ request }: LoaderArgs) {
  const url = new URL(request.url)
  const runId = url.searchParams.get("runId") ?? undefined
  const caseId = url.searchParams.get("caseId") ?? undefined

  let userFilter: Prisma.UserWhereInput = {}

  if (runId) {
    userFilter = {
      prolificId: { not: null },
      createdAt: {
        gte: (prolificRuns as any)[runId].start,
        lte: (prolificRuns as any)[runId].end,
      },
    }
  }

  const demographics = await db.demographic.findMany({
    where: { user: userFilter },
  })
  const votes = await db.vote.findMany({ where: { user: userFilter, caseId } })
  const impressions = await db.impression.findMany({
    where: { user: userFilter, caseId },
  })
  const valueIds = [...new Set(impressions.map((imp) => imp.valuesCardId))]

  // Summarize statistics.
  const statistics = valueIds.map((vid) => {
    const relevantVotes = votes.filter((vote) => vote.valuesCardId === vid)
    const relevantImpressions = impressions.filter(
      (i) => i.valuesCardId === vid
    )
    const votePercentage = relevantVotes.length / relevantImpressions.length
    const politics = calculatePolitics(relevantVotes.map((v) => demographics.find((d) => d.userId === v.userId)))

    return {
      valueId: vid,
      votes: relevantVotes.length,
      impressions: relevantImpressions.length,
      votePercentage,
      politics,
    } as VoteStatistics
  })

  // Return statistics.
  return json({ statistics })
}
