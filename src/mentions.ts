import { PrismaClient } from "@prisma/client";
import Config from "@/utils/config";
import * as Misskey from "misskey-js"
import WebSocket from 'ws';
import { Note } from "./@types";
import YAMAG from "@/utils/misskey"
import { usernameWithHost } from '@/utils'

// load env
Config

let formatOptions:Intl.DateTimeFormatOptions = {
  timeZone: 'Asia/Tokyo',
  hour: 'numeric',
  minute: "numeric",
  second: "numeric",
  fractionalSecondDigits: 3
}

const prisma = new PrismaClient();

const getRecordTxt = async (note:Note):Promise<string> => {
  let record = await prisma.rankRecord.findUnique({ where: { noteId:  note.id }, include: { user: true } })

  let username = usernameWithHost(note.user)
  const dateString = new Date(note.createdAt).toLocaleString('ja-jp', formatOptions)
  const rankTxt = record?.rank ? `${record.rank}位` : '未記録'

  return `@${username}\n順位：${rankTxt}\nノート時刻：${dateString}`
}

const getStatics = async (u:Misskey.entities.User) => {
  let username = usernameWithHost(u)
  const user = await prisma.user.findFirst({ where: { id: u.id }, include: { rankRecords: true } })
  if (user) {
    const cnt = await prisma.rankRecord.count({ where: { userId: user.id } })
    const rankinCnt = await prisma.rankRecord.count({ where: { userId: user.id, rank: {gte:1, lte:10} } })
    const firstCnt = await prisma.rankRecord.count({ where: { userId: user.id, rank: 1 } })
    return `@${username}\n参加回数：${cnt}\nランクイン回数：${rankinCnt}\n1位獲得回数：${firstCnt}`
  } else {
    return `@${username}\n記録なし`
  }
}

(async ()=>{
  const stream = new Misskey.Stream(Config.server.origin, { token: Config.server.credential }, { WebSocket })
  const mainChannel = stream.useChannel('main')
  mainChannel.on('mention', async note => {
    if (note.userId === note.reply?.userId) {
      if(note.reply?.text?.match(Config.matcher)) {
        let text = await getRecordTxt(note.reply)
        YAMAG.Misskey.postNote(text, { replyId: note.id })
      }
    } else if (note.replyId === null || note.reply?.user?.username === Config.userName) {
      let text = await getStatics(note.user)
      YAMAG.Misskey.postNote(text, { replyId: note.id })
    }
  })
})()