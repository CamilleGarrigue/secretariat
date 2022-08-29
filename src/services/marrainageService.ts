import { Marrainage, MarrainageGroup, MarrainageGroupStatus, MARRAINAGE_EVENT } from "@models/marrainage";
import { Domaine, Member } from '@models/member';
import BetaGouv from '@/betagouv';
import * as utils from '@controllers/utils';
import knex from '@/db';
import EventBus from "@/infra/eventBus/eventBus";

interface MarrainageService {
    selectRandomOnboarder(newcomerId: string, domaine: string): Promise<Member>
}

const countNumberOfMarrainage = (onboarders) => {
    const count = {};
    for (const  onboarder of onboarders) {
        if (count[ onboarder]) {
          count[ onboarder] += 1;
        } else {
          count[onboarder] = 0;
        }
    }
    return onboarders.map(onboarder => {
        return {
            onboarder,
            count: count[onboarder]
        }
    })
}

export class MarrainageService1v implements MarrainageService {
    async selectRandomOnboarder(newcomerId: string, domaine: string) {
            const users: Member[] = await BetaGouv.usersInfos();
        const minimumSeniority = new Date().setMonth(new Date().getMonth() - 6);
        const existingCandidates: string[] = await knex('marrainage')
            .select('last_onboarder')
            .where({ completed: false })
            .distinct()
            .then((marrainages: Marrainage[]) => marrainages.map((x) => x.last_onboarder));

        const onboarders = users.filter((x) => {
            const existingCandidate = existingCandidates.includes(x.id);
            const senior = new Date(minimumSeniority) > new Date(x.start);
            const stillActive = !utils.checkUserIsExpired(x);
            const isRequester = x.id === newcomerId;
            return !existingCandidate && senior && stillActive && !isRequester;
        });
        const onboardersFromDomaine = onboarders.filter(onboarder => onboarder.domaine === domaine)
        const onboarderPool = (domaine === Domaine.AUTRE || !onboardersFromDomaine.length) ? onboarders : onboardersFromDomaine
        return onboarderPool[Math.floor(Math.random() * onboarderPool.length)];
    }

    async createMarrainage(newcomerId, onboarderId) {
        return await knex('marrainage')
        .where({ username: newcomerId })
        .increment('count', 1)
        .update({ last_onboarder: onboarderId, last_updated: knex.fn.now() });
    }
}

export class MarrainageServiceWithGroup implements MarrainageService {
    users: Member[];
    MARRAINAGE_GROUP_LIMIT: number;
    MARRAINAGE_GROUP_WEEK_LIMIT: number;

    constructor(
        users: Member[],
        marrainage_group_limit: number,
        marrainage_group_week_limit?: number) {
        this.users = users
        this.MARRAINAGE_GROUP_LIMIT = marrainage_group_limit || 5
        this.MARRAINAGE_GROUP_WEEK_LIMIT = marrainage_group_week_limit || 2
    }

    async selectRandomOnboarder(newcomerId: string, domaine: string) {
        let pendingMarrainageGroup: any = await knex('marrainage_groups').where({
            status: MarrainageGroupStatus.PENDING
        }).first()
        let onboarder
        if (pendingMarrainageGroup) {
            onboarder = pendingMarrainageGroup.onboarder
        } else {
            const marrainageGroups : MarrainageGroup[] = await knex('marrainage_groups').whereNotIn('status', [
                MarrainageGroupStatus.DOING,
                MarrainageGroupStatus.DONE,
            ])
            const onboarders = marrainageGroups.map(marrainageGroup => marrainageGroup.onboarder)
            const sortedOnboarder = countNumberOfMarrainage([...onboarders, ...this.users]).sort(function(a, b){return a-b})
            onboarder = sortedOnboarder[0]
        }
        return onboarder
    }

    async createMarrainage(newcomerId, onboarderId) {
        await knex.transaction(async (trx) => {
            let marrainage_group = await trx('marrainage_groups')
                .where({
                    onboarder: onboarderId,
                    status: MarrainageGroupStatus.PENDING
                })
                .where('count', '<', this.MARRAINAGE_GROUP_LIMIT).first()
            
            if (!marrainage_group) {
                marrainage_group = await trx('marrainage_groups')
                .insert({
                    onboarder: onboarderId,
                    status: MarrainageGroupStatus.PENDING
                }).returning('*').then(res => res[0])
            }
            await trx('marrainage_groups_members')
                .insert({
                    username: newcomerId,
                    marrainage_group_id: marrainage_group.id
                })

            const updateParams = {
                count: marrainage_group.count + 1
            }
            await trx('marrainage_groups')
                .where({
                    id: marrainage_group.id
                })
                .update(updateParams)
        })
    }

    async _setMarrainageToDoing(marrainage_group_id) {
        await knex('marrainage_groups')
            .where({
            id: marrainage_group_id
        })
        .update({
            status: MarrainageGroupStatus.DOING
        })
        console.info(`MarrainageGroup ${marrainage_group_id} status set to DOING`)
        EventBus.produce(MARRAINAGE_EVENT.MARRAINAGE_IS_DOING_EVENT, { marrainage_group_id: marrainage_group_id })
    }

    async checkAndUpdateMarrainagesStatus() {
        const todayLessXdays = new Date()
        todayLessXdays.setDate(todayLessXdays.getDate() - (this.MARRAINAGE_GROUP_WEEK_LIMIT * 7))
        const marrainage_groups : MarrainageGroup[] = await knex('marrainage_groups')
        .where({
          status: MarrainageGroupStatus.PENDING,
        })
        .where('count', '>=', this.MARRAINAGE_GROUP_LIMIT)
        .orWhere('created_at', '<=', todayLessXdays)
        for(const marrainage_group of marrainage_groups) {
          await this._setMarrainageToDoing(marrainage_group.id)
        }
    }

}
