//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
const router = express.Router();

import groupBy from 'lodash/groupBy';
import sortBy from 'lodash/sortBy';

import FossFundRoute from './fossfund';

import { AuthorizeOnlyCorporateAdministrators } from '../../middleware/business/corporateAdministrators';
import { ReposAppRequest, IProviders, ErrorHelper } from '../../transitional';
import { EventRecord } from '../../entities/events/eventRecord';
import { AuthorizeOnlyFullTimeEmployeesAndInterns, isEmployeeOrIntern } from '../../middleware/business/employeesOnly';
import { getOffsetMonthRange } from '../../utils';
import { FossFundElection } from '../../features/fossFundElection';
import { ElectionEntity } from '../../entities/voting/election';

const contributionCaching = false;

interface IContributionsRequest extends ReposAppRequest {
  contributions?: EventRecord[];
  previousContributions?: EventRecord[];
  contributionsLogin?: string;
  electionsSystem?: FossFundElection;
  linkCreated: Date;
  dataRange: Date[];
}

interface IContributionsDocument {
  contributions: EventRecord[];
}

export function getCacheKeyForEmployeeOpenContributions(thirdPartyId: string, electionStart: Date, electionEnd: Date) {
  const key = `contributions:${thirdPartyId}:all:${electionStart.toISOString()}:${electionEnd.toISOString()}`;
  // let contributions = await providers.cacheProvider.getObject(key) as IContributionsDocument;
  return key;
}

const hardcodedDisplayMap = {
  PullRequestEvent: 'Pull requests',
  IssuesEvent: 'Issues',
  IssueCommentEvent: 'Issue comments',
  CommitCommentEvent: 'Commit comments',
  PullRequestReviewEvent: 'Pull request reviews',
  PullRequestReviewCommentEvent: 'Pull request comments',
  'self-service-contribution': 'Self-attested contributions',
};

router.use('/voting', AuthorizeOnlyFullTimeEmployeesAndInterns, FossFundRoute);

router.get('/popular', AuthorizeOnlyCorporateAdministrators, asyncHandler(async (req: ReposAppRequest, res, next) => {
  const providers = req.app.settings.providers as IProviders;
  const { start, end } = getOffsetMonthRange();
  const data = await providers.eventRecordProvider.queryPopularContributions(start, end);
  req.individualContext.webContext.render({
    view: 'contributions/popular',
    title: `CONFIDENTIAL - Popular repos to contribute to`,
    state: {
      start,
      end,
      data,
    },
  });
}));

router.use(asyncHandler(async (req: IContributionsRequest, res, next) => {
  req.reposContext = {
    section: 'contributions',
  };
  const providers = req.app.settings.providers as IProviders;
  const gitHubIdentity = req.individualContext.getGitHubIdentity();
  if (gitHubIdentity?.id) {
    let { id, username } = gitHubIdentity;
    let link = req.individualContext.link;
    const otherUser = req.query.login as string;
    if (otherUser) {
      try {
        link = await providers.linkProvider.getByThirdPartyUsername(otherUser);
        if (link) {
          username = otherUser;
          id = link.thirdPartyId;
        }
      } catch (error) {
        return next(ErrorHelper.IsNotFound(error) ? new Error(`User not linked: ` + otherUser) : error);
      }
    }
    if (link && link['created']) {
      req.linkCreated = link['created'];
    }
    if (req.query.refresh) {
      await refreshMonthContributions(providers, id);
    }
    const currentMonth = getOffsetMonthRange(0);
    let range = [currentMonth.start, currentMonth.end];
    try {
      const system = new FossFundElection(providers);
      req.electionsSystem = system;
      const activeRanges = await system.getActiveElectionsDateRange();
      if (activeRanges && activeRanges.length) {
        range = activeRanges;
      }
    } catch (electionsIgnore) {
      console.log(electionsIgnore);
    }
    const document = await getContributionsByRange(providers, id, range[0], range[1]);
    req.contributions = document && document.contributions ? document.contributions : [];
    req.contributionsLogin = username;
    req.dataRange = range;
  }
  return next();
}));

router.get('/eligibility', AuthorizeOnlyCorporateAdministrators, asyncHandler(async (req: IContributionsRequest, res, next) => {
  const providers = req.app.settings.providers as IProviders;

  // const [start, end] = req.dataRange;

  const priorMonths = getOffsetMonthRange(-2);
  const currentMonth = getOffsetMonthRange(0);
  //const nextMonth = getOffsetMonthRange(1);

  const okrMode = req.query.okr || false;
  const isUsingCurrentElection = !okrMode;
  let start: Date = null;
  let end: Date = null;
  if (isUsingCurrentElection) {
    let elecs = await providers.electionProvider.queryActiveElections();
    elecs = sortBy(elecs, 'votingEnd');
    const elec = elecs.pop();
    start = elec.eligibilityStart;
    end = elec.eligibilityEnd;
  } else {
    start = priorMonths.start;
    end = currentMonth.end;
  }

  const thirdPartyIds = new Set(await providers.eventRecordProvider.queryDistinctEligibleContributors(start, end));

  const linksSource = (await providers.linkProvider.getAll()).filter(link => link && link.corporateUsername);

  const links = linksSource.filter(link => link && link.corporateUsername).filter(link => thirdPartyIds.has(link.thirdPartyId) && !link.isServiceAccount && link.corporateUsername);
  const vendors = links.filter(link => link.corporateUsername.indexOf('-') >= 0);
  const employees = links.filter(link => link.corporateUsername.indexOf('-') === -1);
  const interns = links.filter(link => link.corporateUsername.indexOf('t-') >= 0);

  const publicIds = new Set(await providers.eventRecordProvider.queryDistinctPublicContributors(start, end));
  const publicLinks = linksSource.filter(link => link && link.corporateUsername && publicIds.has(link.thirdPartyId) && !link.isServiceAccount);
  const noLongerLinked = publicLinks.length - publicIds.size;
  const pEmps = publicLinks.filter(link => link.corporateUsername.indexOf('-') === -1);
  const pInterns = publicLinks.filter(link => link.corporateUsername.indexOf('t-') >= 0);
  const pFte = pEmps.length + pInterns.length;

  const allLinksNotServiceAccounts = linksSource.filter(link => link && link.corporateUsername && !link.isServiceAccount);
  const aEmps = allLinksNotServiceAccounts.filter(link => link.corporateUsername.indexOf('-') === -1);
  const aInterns = allLinksNotServiceAccounts.filter(link => link.corporateUsername.indexOf('t-') >= 0);
  const fte = aEmps.length + aInterns.length;

  const sorted = sortBy(employees, 'corporateDisplayName');
  const columnCount = 3;
  req.individualContext.webContext.render({
    view: 'contributions/eligible',
    title: `CONFIDENTIAL - Eligible open source contributors from ${start} to ${end}`,
    state: {
      start,
      end,
      noLongerLinked,
      pFte,
      links,
      linksCount: links.length,
      fte,
      vendorCount: vendors.length,
      count: sorted.length,
      eligibleByColumn: [...Array(columnCount).keys()].map(c => sorted.filter((_, i) => i % columnCount === c)),
    },
  });
}));

async function showContributions(req: IContributionsRequest, start: Date, end: Date): Promise<void> {
  const username = req.contributionsLogin;
  const isEmployee = isEmployeeOrIntern(req.individualContext.corporateIdentity.username);
  let elections: ElectionEntity[] = [];
  if (req.electionsSystem) {
    elections.push(... await req.electionsSystem.getActiveElections());
  }
  const now = new Date();
  elections = elections.filter(election => new Date(election.votingEnd) > now);
  if (!req.individualContext.getGitHubIdentity()) {
    return req.individualContext.webContext.render({
      view: 'contributions',
      title: `GitHub contributions`,
      state: {
        start,
        end,
        login: username,
        elections,
        electionsSystem: req.electionsSystem,
        isEmployee,
      },
    });
  }
  const isSelf = username.toLowerCase() === req.individualContext.getGitHubIdentity().username.toLowerCase();
  const isOtherEventsDisplay = req.query['other'] === '1';
  const isTruncating = req.query['all'] !== '1';
  let eligibleStartMonths = [];
  const openContributions = req.contributions.filter(event => event.isOpenContribution || event.additionalData.contribution);
  const otherContributionsData = req.contributions.filter(event => !(event.isOpenContribution || event.additionalData.contribution));
  const eligibleElectionIds = [];
  for (const election of elections) {
    const es = new Date(election.eligibilityStart);
    const ee = new Date(election.eligibilityEnd);
    const electionOpenContributions = openContributions.filter(event => new Date(event.created) >= es && new Date(event.created) <= ee);
    if (electionOpenContributions.length > 0) {
      eligibleElectionIds.push(election.electionId);
    }
  }
  const contributions = groupBy(openContributions, contrib => contrib.action);
  const otherContributions = groupBy(otherContributionsData, contrib => contrib.action);
  const linkCreated = req.linkCreated;
  let recentlyLinked = false;
  if (linkCreated) {
    const now = new Date();
    if (linkCreated > new Date(now.getTime() - (1000 * 60 * 60 * 24 * 2))) {
      recentlyLinked = true;
    }
  }
  req.individualContext.webContext.render({
    view: 'contributions',
    title: `GitHub contributions made by ${username}`,
    state: {
      start,
      end,
      login: username,
      isOtherEventsDisplay,
      isSelf,
      contributionTypes: Object.getOwnPropertyNames(hardcodedDisplayMap),
      contributionDescriptions: hardcodedDisplayMap,
      contributions,
      contributionCount: openContributions.length,
      otherContributions,
      otherContributionsCount: otherContributionsData.length,
      isTruncating,
      elections,
      electionsSystem: req.electionsSystem,
      // eligibleStartMonths,
      eligibleElectionIds,
      isEmployee,
      recentlyLinked,
    },
  });
}

// The contributions page can be shown to any user, but not the nomination experience.

router.get('/', asyncHandler(async (req: IContributionsRequest, res, next) => {
  await showContributions(req, req.dataRange ? req.dataRange[0] : null, req.dataRange ? req.dataRange[1] : null);
}));

async function refreshMonthContributions(providers: IProviders, thirdPartyId: string, offsetMonths?: number): Promise<void> {
  const account = providers.operations.getAccount(thirdPartyId);
  await account.getDetails();
  await account.getEvents({
    backgroundRefresh: false,
    maxAgeSeconds: 0,
  });
  const { start, end } = getOffsetMonthRange(offsetMonths);
  if (contributionCaching) {
    const key = getCacheKeyForEmployeeOpenContributions(thirdPartyId, start, end);
    await providers.cacheProvider.delete(key);
  }
}

async function getContributionsByRange(providers: IProviders, thirdPartyId: string, start: Date, end: Date): Promise<IContributionsDocument> {
  const key = getCacheKeyForEmployeeOpenContributions(thirdPartyId, start, end);
  if (contributionCaching) {
    let contributions = await providers.cacheProvider.getObject(key) as IContributionsDocument;
    if (contributions) {
      return contributions;
    }
  }
  const records = await providers.eventRecordProvider.queryOpenContributionEventsByDateRangeAndThirdPartyId(
    thirdPartyId,
    start,
    end,
    false /* do not only limit to open contributions */);
  const openContributions = records.filter(r => r.isOpenContribution === true).length;
  const ttlMinutes = openContributions ? 5 : 1;
  if (contributionCaching) {
    await providers.cacheProvider.setObjectWithExpire(key, { contributions: records }, ttlMinutes);
  }
  return { contributions: records || [] };
}

// function getMonthContributions(providers: IProviders, thirdPartyId: string, offsetMonth: number): Promise<IContributionsDocument> {
//   const { start, end } = getOffsetMonthRange(offsetMonth);
//   return getContributionsByRange(providers, thirdPartyId, start, end);
// }

export default router;
