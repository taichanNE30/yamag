import YAMAG from '@/utils/misskey'
import { Note, Record } from '@/@types'
import { RankElement, usernameWithHost, isRecordInRange } from '@/utils'
import Config from '@/utils/config'
import { Constants } from '@/utils/constants'
import retry from 'async-retry'
import { PrismaClient } from '@prisma/client'

let notes: Array<Note> = []

const createRanks = (notes: Array<Note>):Array<RankElement> => {
  const counted = new Set<Note['id']>();

  const records:Array<Record> = notes.sort((a, b) => {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  }).map(note => {
    const username = usernameWithHost(note.user)

    if(!counted.has(username)) {
      counted.add(username)
      return { date: new Date(note.createdAt), note }
    }
  }).filter((record): record is Exclude<typeof record, undefined> => record !== undefined)

  const inRange:Array<Record> = records.filter(record => isRecordInRange(record, Config.recordTime))
  const outOfRange:Array<Record> = records.filter(record => !isRecordInRange(record, Config.recordTime))

  const ranked:Array<RankElement> = []
  inRange.forEach((record, i, org) => {
    let rank = 1;
    if (i > 0) {
      rank = record.date.getTime() === org[i - 1].date.getTime() ? ranked[i - 1].rank : i + 1
    }
    ranked.push(new RankElement(rank, record))
  })
  outOfRange.forEach(record => {
    ranked.push(new RankElement(-1, record))
  })

  return ranked
}

const storeRanks = async (ranks:Array<RankElement>) => {
  const prisma = new PrismaClient();
  const date = await prisma.rankDate.findUnique({ where: { date: Config.recordTime } }) ||
               await prisma.rankDate.create({ data: { date: Config.recordTime } })
  const rankRecords = await Promise.all(
    ranks.map(async (rank)  => {
      const userId = rank.userId
      const user = await prisma.user.findUnique({ where: { id: userId } }) ||
                   await prisma.user.create({ data: { id: userId, userName: rank.username} })
      return { rank: rank.rank, userId: user.id, noteId: rank.noteId, rankDateId: date.id, postedAt: rank.date }
    })
  )
  const created = await prisma.rankRecord.createMany({ data: rankRecords, skipDuplicates: true })
  console.log(created)
}

const showRanking = (ranked: Array<RankElement>) => {
  let rankUserText:string = ranked.filter(el => 0 < el.rank && el.rank <= 10).map(el => 
    `${Constants.rankEmojis[el.rank - 1]} @${el.username} +${el.formattedDiff(Config.recordTime)}`
  ).join("\n")
  let validCount = ranked.reduce((acc, curr)=> {
    if (curr.rank > 0) acc += 1
    return acc
  }, 0)
  return `${Config.postTitle}\n\n${rankUserText}\n\n有効記録数：${validCount}\nフライング記録数：${ranked.length - validCount}`
}

const getLastNote = (notes:Array<Note>) => notes.slice(-1)[0];

const getNotes = async ():Promise<Array<Note>> => {
  const since = Config.recordTime.getTime() - (60 * 1000)
  const until = Config.recordTime.getTime() + (60 * 1000)
  const options = {
    excludeNsfw: false,
    limit: 100,
    sinceDate: since
  }
  console.log('loading notes...')
  let notes = await retry(
    async ()=> await YAMAG.Misskey.request('notes/hybrid-timeline', options),
    { retries: 5, onRetry: ()=> { console.log("retrying...") } }
  )
  if (notes.length === 0) return []

  while (new Date(getLastNote(notes).createdAt).getTime() < until) {
    const newNotes = await retry(async ()=> {
        return await YAMAG.Misskey.request('notes/hybrid-timeline', {
          sinceId: getLastNote(notes).id,
          ...options
        })
      }, {
        retries: 5,
        onRetry: ()=> { console.log("retrying...") }
      }
    )
    notes = notes.concat(newNotes)
    console.log(notes.length)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return notes
}

(async ()=>{
  console.log("getNotes start")
  notes = await getNotes()
  console.log("getNotes end")

  let regexp = new RegExp(Config.matcher)
  let recordedNotes = notes.filter(note => note.text?.match(regexp))
  let filteredNotes = recordedNotes.filter(note => {
    return !['334', Config.userName].includes(note.user.username) &&
            ['public', 'home'].includes(note.visibility) &&
            note.user.host === null
  })
  let ranking = createRanks(filteredNotes)
  let text = showRanking(ranking)
  YAMAG.Misskey.postNote(text)
  if (Config.isDbEnabled()) {
    storeRanks(ranking)
  }
})()
