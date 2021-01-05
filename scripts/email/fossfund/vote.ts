//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

/*eslint no-console: ["error", { allow: ["log"] }] */

import _ from 'lodash';

import app, { IReposJob } from '../../../app';
import { isEmployeeOrIntern } from '../../../middleware/business/employeesOnly';
import { sleep } from '../../../utils';
import { IMail } from '../../../lib/mailProvider';
import { UserSettings } from '../../../entities/userSettings';

let fakeSend = false;

let markIneligibleAsSent = false;

const showNotEligible = false;

const sendBcc = false;

app.runJob(async function work({ providers }: IReposJob) {
  let runLimit = 100000 * 50;
  let inRun = 0;
  const campaignGroupId = 'fossfund';
  const campaignId = 'fund5';
  const emailViewName = 'fossfund-vote'; // `${campaignGroupId}-${campaignId}`;
  const { config, linkProvider, operations, eventRecordProvider, electionProvider, electionVoteProvider, electionNominationProvider, mailAddressProvider, campaignStateProvider, userSettingsProvider } = providers;
  const now = new Date();
  const electionSet = (await electionProvider.queryActiveElections()).filter(election => new Date(election.votingEnd) > now);
  if (electionSet.length !== 1) {
    throw new Error(`election set length: ${electionSet.length}`);
  }
  const election = electionSet[0];
  const start = new Date(election.eligibilityStart);
  const end = new Date(election.eligibilityEnd);
  const nominees = await electionNominationProvider.queryApprovedElectionNominees(election.electionId);
  let employees = (await linkProvider.getAll())
    .filter(resource => isEmployeeOrIntern(resource.corporateUsername))
    .filter(resource => !resource.isServiceAccount)
//    .filter(resource => resource.corporateDisplayName.includes('Emma Irwin'));
  employees = _.shuffle(employees);
  let optOuts = 0;
  let i = 0;
  for (const employee of employees) {
    ++i;
    try {
      const corporateId = employee.corporateId;
      if (inRun > runLimit) {
        continue;
      }
      ++inRun;
      const state = await campaignStateProvider.getState(corporateId, campaignGroupId, campaignId);
      if (state.optOut) {
        console.log(`[oo: ${++optOuts}]`);
        console.log(`[opt-out] employee id=${corporateId} has opted out of the campaign group=${campaignGroupId}`);
        continue;
      }
      if (state.sent) {
        await sleep(5);
        console.log(`[already-sent] eid=${corporateId} ${inRun}/${employees.length}/${runLimit}`)
        continue;
      }
      // have they voted already?
      const voteState = (await electionVoteProvider.queryVotesByCorporateId(corporateId)).filter(vote => vote.electionId === election.electionId);
      const hasVoted = voteState.length > 0;
      if (hasVoted) {
        // do not nag them since they already got there
        console.log(`[already-voted] employee=${employee.corporateDisplayName} has already voted so will be marked as SENT`);
        await campaignStateProvider.setSent(corporateId, campaignGroupId, campaignId);
        continue;
      }
      await sleep(5);
      const events = await eventRecordProvider.queryOpenContributionEventsByDateRangeAndCorporateId(
        employee.corporateId,
        start,
        end,
        false /* corporate and open source contributions wanted */);
      const openContributions = events.filter(event => event.isOpenContribution || event.additionalData.contribution);
      if (openContributions.length === 0) {
        // not an open source contributor for the election
        // mark this as "sent" to skip in the future
        if (showNotEligible) {
          console.log(`[not-eligible] employee ${employee.corporateDisplayName} has 0 contributions this eligibility period`);
        }
        if (markIneligibleAsSent) {
          await campaignStateProvider.setSent(corporateId, campaignGroupId, campaignId);
        }
        continue;
      }
      let userSettings: UserSettings = null;
      try {
        userSettings = await userSettingsProvider.getUserSettings(corporateId);
      } catch (noSettingsError) {
        // that's OK
      }
      const otherContributionsData = events.filter(event => !(event.isOpenContribution || event.additionalData.contribution));
      const contributions = _.groupBy(openContributions, contrib => contrib.action);
      let subject = `You have qualified to vote: ${election.title}. Let's give $10,000 to open source!`;
      let headline = 'FOSS Fund';
      let address = await mailAddressProvider.getAddressFromUpn(employee.corporateUsername);
      if (fakeSend) {
        address = 'jeff.wilcox@microsoft.com';
      }
      if (!address) {
        console.log(`[noemail] No e-mail address for ${employee.corporateUsername}`);
        continue;
      }
      const bcc = sendBcc ? ('jwilcox@microsoft.com' || config.brand?.electionMail) : undefined;
      const email: IMail = {
        to: address,
        bcc,
        subject,
        content: await operations.emailRender(emailViewName, {
          reason: (`This mail was sent to ${address} for the GitHub user ${employee.thirdPartyUsername} linked to ${employee.corporateDisplayName} as part of the FOSS Fund community initiative.`),
          unsubscribeText: 'Opt-out of future FOSS Fund emails',
          unsubscribeLink: `https://repos.opensource.microsoft.com/settings/campaigns/${campaignGroupId}/unsubscribe`,
          headline,
          election,
          nominees: _.shuffle(nominees),
          notification: 'information',
          app: `Microsoft Open Source`,
          employee,
          openContributions,
          contributions,
          otherContributionsData,
          userSettings,
          viewServices: providers.viewServices,
        }),
      };
      if (!fakeSend) {
        await campaignStateProvider.setSent(corporateId, campaignGroupId, campaignId);
      }
      await operations.sendMail(email);
      console.log(`[${fakeSend ? 'fake send' : 'OK'}] ${inRun}/${employees.length}/${runLimit}: sent to ${corporateId} and set state for ${employee.corporateUsername} ${employee.corporateDisplayName}`);
      //console.log(`OK sent to ${corporateId} and didn't state *** for ${employee.corporateUsername} ${employee.corporateDisplayName}`);
      await sleep(10);

      if (i % 100 === 0) {
        console.log();
        console.log('long sleep...');
        await sleep(5000);
        console.log('moving along...');
        console.log();
      }
    } catch (processEmployeeError) {
      console.dir(processEmployeeError);
    }
  }
});
