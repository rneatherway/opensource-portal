//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';

import { jsonError } from '../../../middleware/jsonError';
import { IProviders, ReposAppRequest } from '../../../transitional';
import { Organization } from '../../../business/organization';
import { MemberSearch } from '../../../business/memberSearch';
import { ICrossOrganizationMembersResult, Operations } from '../../../business/operations';
import { corporateLinkToJson, ICorporateLink } from '../../../business/corporateLink';
import { OrganizationMember } from '../../../business/organizationMember';

import LeakyLocalCache, { getLinksLightCache } from './leakyLocalCache';
import JsonPager from './jsonPager';

const router = express.Router();

// BAD PRACTICE: leaky local cache
// CONSIDER: use a better approach
const leakyLocalCachePeople = new LeakyLocalCache<boolean, ICrossOrganizationMembersResult>();

async function getPeopleAcrossOrganizations(operations: Operations) {
  const value = leakyLocalCachePeople.get(true);
  if (value) {
    return { crossOrganizationMembers: value };
  }
  const crossOrganizationMembers = await operations.getMembers();
  leakyLocalCachePeople.set(true, crossOrganizationMembers);
  return { crossOrganizationMembers };
}

export async function equivalentLegacyPeopleSearch(req: ReposAppRequest) {
  const { operations } = req.app.settings.providers as IProviders;
  const links = await getLinksLightCache(operations);
  const org = req.organization ? req.organization.name : null;
  const orgId = req.organization ? (req.organization as Organization).id : null;
  const { crossOrganizationMembers } = await getPeopleAcrossOrganizations(operations);
  const page = req.query.page_number ? Number(req.query.page_number) : 1;
  let phrase = req.query.q as string;
  let type = req.query.type as string;
  const validTypes = new Set([
    'linked',
    'active',
    'unlinked',
    'former',
    'serviceAccount',
    'unknownAccount',
    'owners',
  ]);
  if (!validTypes.has(type)) {
    type = null;
  }
  const filters = [];
  if (type) {
    filters.push({
      type: 'type',
      value: type,
      displayValue: type === 'former' ? 'formerly known' : type,
      displaySuffix: 'members',
    });
  }
  if (phrase) {
    filters.push({
      type: 'phrase',
      value: phrase,
      displayPrefix: 'matching',
    });
  }
  const search = new MemberSearch({
    phrase,
    type,
    pageSize: 1000000, // temporary, just return it all, we'll slice it locally
    links,
    providers: operations.providers,
    orgId,
    // organizationMembers,
    crossOrganizationMembers,
    isOrganizationScoped: false,
    // team2AddType: null, // req.team2AddType, // Used to enable the "add a member" or maintainer experience for teams
    // teamMembers, // Used to filter team members in ./org/ORG/team/TEAM/members and other views
  });
  await search.search(page, req.query.sort as string);
  return search;
}

interface ISimpleAccount {
  login: string;
  avatar_url: string;
  id: number;
}

interface ICrossOrganizationMemberResponse {
  account: ISimpleAccount;
  link?: ICorporateLink;
  organizations: string[];
}

interface ICrossOrganizationSearchedMember {
  id: number;
  account: ISimpleAccount;
  link?: ICorporateLink;
  orgs: IOrganizationMembershipAccount;
}

interface IOrganizationMembershipAccount {
  [id: string]: ISimpleAccount;
}

router.get('/', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const pager = new JsonPager<ICrossOrganizationSearchedMember>(req, res);
  try {
    const searcher = await equivalentLegacyPeopleSearch(req);
    const members = searcher.members as unknown as ICrossOrganizationSearchedMember[];
    const slice = pager.slice(members);
    return pager.sendJson(slice.map(xMember => {
        const obj = Object.assign({
          link: xMember.link ? corporateLinkToJson(xMember.link) : null,
          id: xMember.id,
          organizations: xMember.orgs ? Object.getOwnPropertyNames(xMember.orgs) : [],
        }, xMember.account || { id: xMember.id });
        return obj;
      }),
    );
  } catch (repoError) {
    console.dir(repoError);
    return next(jsonError(repoError));
  }
}));

router.use('*', (req, res, next) => {
  return next(jsonError('no API or function available within this cross-organization people list', 404));
});

export default router;
