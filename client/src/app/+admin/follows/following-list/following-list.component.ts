import { SortMeta } from 'primeng/api'
import { Component, OnInit, ViewChild } from '@angular/core'
import { ConfirmService, Notifier, RestPagination, RestTable } from '@app/core'
import { AdvancedInputFilter } from '@app/shared/shared-forms'
import { InstanceFollowService } from '@app/shared/shared-instance'
import { ActorFollow } from '@shared/models'
import { FollowModalComponent } from './follow-modal.component'
import { DropdownAction } from '@app/shared/shared-main'
import { prepareIcu } from '@app/helpers'

@Component({
  templateUrl: './following-list.component.html',
  styleUrls: [ './following-list.component.scss' ]
})
export class FollowingListComponent extends RestTable implements OnInit {
  @ViewChild('followModal') followModal: FollowModalComponent

  following: ActorFollow[] = []
  totalRecords = 0
  sort: SortMeta = { field: 'createdAt', order: -1 }
  pagination: RestPagination = { count: this.rowsPerPage, start: 0 }

  searchFilters: AdvancedInputFilter[] = []

  selectedFollows: ActorFollow[] = []
  bulkFollowsActions: DropdownAction<ActorFollow[]>[] = []

  constructor (
    private notifier: Notifier,
    private confirmService: ConfirmService,
    private followService: InstanceFollowService
  ) {
    super()
  }

  ngOnInit () {
    this.initialize()

    this.searchFilters = this.followService.buildFollowsListFilters()

    this.bulkFollowsActions = [
      {
        label: $localize`Delete`,
        handler: follows => this.removeFollowing(follows)
      }
    ]
  }

  getIdentifier () {
    return 'FollowingListComponent'
  }

  openFollowModal () {
    this.followModal.openModal()
  }

  isInstanceFollowing (follow: ActorFollow) {
    return follow.following.name === 'peertube'
  }

  isInSelectionMode () {
    return this.selectedFollows.length !== 0
  }

  buildFollowingName (follow: ActorFollow) {
    return follow.following.name + '@' + follow.following.host
  }

  async removeFollowing (follows: ActorFollow[]) {
    const message = prepareIcu($localize`Do you really want to unfollow {count, plural, =1 {{entryName}?} other {{count} entries?}}`)(
      { count: follows.length, entryName: this.buildFollowingName(follows[0]) },
      $localize`Do you really want to unfollow these entries?`
    )

    const res = await this.confirmService.confirm(message, $localize`Unfollow`)
    if (res === false) return

    this.followService.unfollow(follows)
      .subscribe({
        next: () => {
          // eslint-disable-next-line max-len
          const message = prepareIcu($localize`You are not following {count, plural, =1 {{entryName} anymore.} other {these {count} entries anymore.}}`)(
            { count: follows.length, entryName: this.buildFollowingName(follows[0]) },
            $localize`You are not following them anymore.`
          )

          this.notifier.success(message)
          this.reloadData()
        },

        error: err => this.notifier.error(err.message)
      })
  }

  protected reloadData () {
    this.followService.getFollowing({ pagination: this.pagination, sort: this.sort, search: this.search })
                      .subscribe({
                        next: resultList => {
                          this.following = resultList.data
                          this.totalRecords = resultList.total
                        },

                        error: err => this.notifier.error(err.message)
                      })
  }
}
