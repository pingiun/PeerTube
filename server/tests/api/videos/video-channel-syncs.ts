/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import { expect } from 'chai'
import { FIXTURE_URLS } from '@server/tests/shared'
import { areHttpImportTestsDisabled } from '@shared/core-utils'
import { HttpStatusCode, VideoChannelSyncState, VideoInclude, VideoPrivacy } from '@shared/models'
import {
  createMultipleServers,
  getServerImportConfig,
  killallServers,
  PeerTubeServer,
  setAccessTokensToServers,
  setDefaultAccountAvatar,
  setDefaultChannelAvatar,
  setDefaultVideoChannel,
  waitJobs
} from '@shared/server-commands'

describe('Test channel synchronizations', function () {
  if (areHttpImportTestsDisabled()) return

  function runSuite (mode: 'youtube-dl' | 'yt-dlp') {

    describe('Sync using ' + mode, function () {
      let servers: PeerTubeServer[]

      let startTestDate: Date

      let rootChannelSyncId: number
      const userInfo = {
        accessToken: '',
        username: 'user1',
        channelName: 'user1_channel',
        channelId: -1,
        syncId: -1
      }

      async function changeDateForSync (channelSyncId: number, newDate: string) {
        await servers[0].sql.updateQuery(
          `UPDATE "videoChannelSync" ` +
          `SET "createdAt"='${newDate}', "lastSyncAt"='${newDate}' ` +
          `WHERE id=${channelSyncId}`
        )
      }

      before(async function () {
        this.timeout(240_000)

        startTestDate = new Date()

        servers = await createMultipleServers(2, getServerImportConfig(mode))

        await setAccessTokensToServers(servers)
        await setDefaultVideoChannel(servers)
        await setDefaultChannelAvatar(servers)
        await setDefaultAccountAvatar(servers)

        await servers[0].config.enableChannelSync()

        {
          userInfo.accessToken = await servers[0].users.generateUserAndToken(userInfo.username)

          const { videoChannels } = await servers[0].users.getMyInfo({ token: userInfo.accessToken })
          userInfo.channelId = videoChannels[0].id
        }
      })

      it('Should fetch the latest channel videos of a remote channel', async function () {
        this.timeout(120_000)

        {
          const { video } = await servers[0].imports.importVideo({
            attributes: {
              channelId: servers[0].store.channel.id,
              privacy: VideoPrivacy.PUBLIC,
              targetUrl: FIXTURE_URLS.youtube
            }
          })

          expect(video.name).to.equal('small video - youtube')
          expect(video.waitTranscoding).to.be.true

          const { total } = await servers[0].videos.listByChannel({ handle: 'root_channel', include: VideoInclude.NOT_PUBLISHED_STATE })
          expect(total).to.equal(1)
        }

        const { videoChannelSync } = await servers[0].channelSyncs.create({
          attributes: {
            externalChannelUrl: FIXTURE_URLS.youtubeChannel,
            videoChannelId: servers[0].store.channel.id
          },
          token: servers[0].accessToken,
          expectedStatus: HttpStatusCode.OK_200
        })
        rootChannelSyncId = videoChannelSync.id

        // Ensure any missing video not already fetched will be considered as new
        await changeDateForSync(videoChannelSync.id, '1970-01-01')

        await servers[0].debug.sendCommand({
          body: {
            command: 'process-video-channel-sync-latest'
          }
        })

        {
          await waitJobs(servers)

          const { total, data } = await servers[0].videos.listByChannel({
            handle: 'root_channel',
            include: VideoInclude.NOT_PUBLISHED_STATE
          })
          expect(total).to.equal(2)
          expect(data[0].name).to.equal('test')
          expect(data[0].waitTranscoding).to.be.true
        }
      })

      it('Should add another synchronization', async function () {
        const externalChannelUrl = FIXTURE_URLS.youtubeChannel + '?foo=bar'

        const { videoChannelSync } = await servers[0].channelSyncs.create({
          attributes: {
            externalChannelUrl,
            videoChannelId: servers[0].store.channel.id
          },
          token: servers[0].accessToken,
          expectedStatus: HttpStatusCode.OK_200
        })

        expect(videoChannelSync.externalChannelUrl).to.equal(externalChannelUrl)
        expect(videoChannelSync.channel).to.include({
          id: servers[0].store.channel.id,
          name: 'root_channel'
        })
        expect(videoChannelSync.state.id).to.equal(VideoChannelSyncState.WAITING_FIRST_RUN)
        expect(new Date(videoChannelSync.createdAt)).to.be.above(startTestDate).and.to.be.at.most(new Date())
      })

      it('Should add a synchronization for another user', async function () {
        const { videoChannelSync } = await servers[0].channelSyncs.create({
          attributes: {
            externalChannelUrl: FIXTURE_URLS.youtubeChannel + '?baz=qux',
            videoChannelId: userInfo.channelId
          },
          token: userInfo.accessToken
        })
        userInfo.syncId = videoChannelSync.id
      })

      it('Should not import a channel if not asked', async function () {
        await waitJobs(servers)

        const { data } = await servers[0].channelSyncs.listByAccount({ accountName: userInfo.username })

        expect(data[0].state).to.contain({
          id: VideoChannelSyncState.WAITING_FIRST_RUN,
          label: 'Waiting first run'
        })
      })

      it('Should only fetch the videos newer than the creation date', async function () {
        this.timeout(120_000)

        await changeDateForSync(userInfo.syncId, '2019-03-01')

        await servers[0].debug.sendCommand({
          body: {
            command: 'process-video-channel-sync-latest'
          }
        })

        await waitJobs(servers)

        const { data, total } = await servers[0].videos.listByChannel({
          handle: userInfo.channelName,
          include: VideoInclude.NOT_PUBLISHED_STATE
        })

        expect(total).to.equal(1)
        expect(data[0].name).to.equal('test')
      })

      it('Should list channel synchronizations', async function () {
        // Root
        {
          const { total, data } = await servers[0].channelSyncs.listByAccount({ accountName: 'root' })
          expect(total).to.equal(2)

          expect(data[0]).to.deep.contain({
            externalChannelUrl: FIXTURE_URLS.youtubeChannel,
            state: {
              id: VideoChannelSyncState.SYNCED,
              label: 'Synchronized'
            }
          })

          expect(new Date(data[0].lastSyncAt)).to.be.greaterThan(startTestDate)

          expect(data[0].channel).to.contain({ id: servers[0].store.channel.id })
          expect(data[1]).to.contain({ externalChannelUrl: FIXTURE_URLS.youtubeChannel + '?foo=bar' })
        }

        // User
        {
          const { total, data } = await servers[0].channelSyncs.listByAccount({ accountName: userInfo.username })
          expect(total).to.equal(1)
          expect(data[0]).to.deep.contain({
            externalChannelUrl: FIXTURE_URLS.youtubeChannel + '?baz=qux',
            state: {
              id: VideoChannelSyncState.SYNCED,
              label: 'Synchronized'
            }
          })
        }
      })

      it('Should list imports of a channel synchronization', async function () {
        const { total, data } = await servers[0].imports.getMyVideoImports({ videoChannelSyncId: rootChannelSyncId })

        expect(total).to.equal(1)
        expect(data).to.have.lengthOf(1)
        expect(data[0].video.name).to.equal('test')
      })

      it('Should remove user\'s channel synchronizations', async function () {
        await servers[0].channelSyncs.delete({ channelSyncId: userInfo.syncId })

        const { total } = await servers[0].channelSyncs.listByAccount({ accountName: userInfo.username })
        expect(total).to.equal(0)
      })

      // FIXME: youtube-dl doesn't work when speicifying a port after the hostname
      // it('Should import a remote PeerTube channel', async function () {
      //   this.timeout(240_000)

      //   await servers[1].videos.quickUpload({ name: 'remote 1' })
      //   await waitJobs(servers)

      //   const { videoChannelSync } = await servers[0].channelSyncs.create({
      //     attributes: {
      //       externalChannelUrl: servers[1].url + '/c/root_channel',
      //       videoChannelId: userInfo.channelId
      //     },
      //     token: userInfo.accessToken
      //   })
      //   await servers[0].channels.importVideos({
      //     channelName: userInfo.channelName,
      //     externalChannelUrl: servers[1].url + '/c/root_channel',
      //     videoChannelSyncId: videoChannelSync.id,
      //     token: userInfo.accessToken
      //   })

      //   await waitJobs(servers)

      //   const { data, total } = await servers[0].videos.listByChannel({
      //     handle: userInfo.channelName,
      //     include: VideoInclude.NOT_PUBLISHED_STATE
      //   })

      //   expect(total).to.equal(2)
      //   expect(data[0].name).to.equal('remote 1')
      // })

      // it('Should keep synced a remote PeerTube channel', async function () {
      //   this.timeout(240_000)

      //   await servers[1].videos.quickUpload({ name: 'remote 2' })
      //   await waitJobs(servers)

      //   await servers[0].debug.sendCommand({
      //     body: {
      //       command: 'process-video-channel-sync-latest'
      //     }
      //   })

      //   await waitJobs(servers)

      //   const { data, total } = await servers[0].videos.listByChannel({
      //     handle: userInfo.channelName,
      //     include: VideoInclude.NOT_PUBLISHED_STATE
      //   })
      //   expect(total).to.equal(2)
      //   expect(data[0].name).to.equal('remote 2')
      // })

      after(async function () {
        await killallServers(servers)
      })
    })
  }

  runSuite('youtube-dl')
  runSuite('yt-dlp')
})
