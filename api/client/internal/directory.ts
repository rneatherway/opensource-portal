//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';

import axios from 'axios';
import querystring from 'querystring';

import { IndividualContext } from '../../../user';
import { jsonError } from '../../../middleware/jsonError';
import { ErrorHelper, IProviders, ReposAppRequest } from '../../../transitional';
import { AuthenticationContext, ErrorResponse, TokenResponse } from 'adal-node';

const router = express.Router();

async function getUserAccessToken(req: ReposAppRequest): Promise<string> {
  const { oauthAccessToken } = req;
  if (!oauthAccessToken) {
    throw new Error('No available OAuth access token for the user');
  }
  if (oauthAccessToken.expired()) {
    console.log('expired!');
  }
  // Token expiration and refresh is handled by middleware ahead of this API
  if (!oauthAccessToken.token.access_token) {
    throw new Error('Access token not available');
  }
  return oauthAccessToken.token.access_token;
}

// Client-available group features:
// - get a group by specific nickname
// - get a user by specific alias

async function makeGraphRequest(token: string, uri: string, qs: string): Promise<any> {
  const url = `${uri}${qs ? '?' + qs : ''}`;
  console.log(url);
  try {
    const { data } = await axios({
      url,
      headers: {
        Authorization: `Bearer ${token}`,
      }
    });
    console.dir(data);
    return data;
  } catch (error) {
    const { response } = error;
    if (response) {
      const { status } = response;
      if (status === 404) {
        throw jsonError(error, 404);
      } else if (status >= 400) {
        const body = response.data || {};
        const extraMessage = body?.error?.message ? `${body.error.message} ` : '';
        const err = new Error(`${extraMessage}${status}`);
        throw jsonError(err, response.status);
      }
    }
    throw jsonError(error);
  }
}

async function proxyGraphForApp(req: ReposAppRequest, res, next) {
  const { graphProvider } = req.app.settings.providers as IProviders;
  const { path } = req;
  console.log('proxy aad -app-: ' + path);
  const moniker = 'v1.0/';
  const i = path.indexOf(moniker);
  if (i < 0) {
    return next(jsonError('Invalid path', 400));
  }
  const graphPath = path.substr(i + moniker.length);
  const token = await graphProvider.getToken();
  //const qsMarker = req.originalUrl.indexOf('?');
  //let qsRemainderOriginal = qsMarker >= 0 ? '?' + req.originalUrl.substr(qsMarker) : '';
  //const qs = req.query ? qsRemainderOriginal : null;
  const qs = req.query ? querystring.stringify(req.query as any) : null;
  const url = `https://graph.microsoft.com/v1.0/${graphPath}`;
  try {
    const data = await makeGraphRequest(token, url, qs);
    return res.json(data);
  } catch (error) {
    return next(error);
  }
}

async function proxyGraphForSelf(req: ReposAppRequest, res, next) {
  const { path } = req;
  console.log('proxy aad -self-: ' + path);
  const moniker = 'v1.0/me';
  const i = path.indexOf(moniker);
  if (i < 0) {
    return next(jsonError('Invalid path', 400));
  }
  const graphPath = path.substr(i + moniker.length + 1);
  const token = await getUserAccessToken(req);
  const qs = req.query ? querystring.stringify(req.query as any) : null;
  const url = `https://graph.microsoft.com/v1.0/me/${graphPath}`;
  try {
    const data = await makeGraphRequest(token, url, qs);
    return res.json(data);
  } catch (error) {
    return next(error);
  }
}

router.get('/proxy/v1.0/me/people', asyncHandler(async (req: ReposAppRequest, res, next) => {
  console.log('simulated fake aad: ' + req.path);
  const token = await getUserAccessToken(req);
  const qs = req.query ? querystring.stringify(req.query as any) : null;
  const url = `https://graph.microsoft.com/v1.0/me${qs}`;
  const justTheUser = await makeGraphRequest(token, url, qs);
  return res.json({
    '@odata.context': 'simulated',
    // "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/people?$skip=0",
    'value': [
      justTheUser,
    ],
  });
}));

router.get('/proxy/v1.0/me', proxyGraphForSelf);
router.get('/proxy/v1.0/me/*', proxyGraphForSelf);
router.get('/proxy/v1.0/*', proxyGraphForApp);

router.get('/proxy/v1.0/*', asyncHandler(async (req: ReposAppRequest, res, next) => {
  console.log('proxy aad: ' + req.path);
  return res.json({
    "value": []
  });
}));

router.get('/group/:id', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const id = req.params.id;
  if (!id) {
    return next(jsonError('id required', 400));
  }
  const { graphProvider } = req.app.settings.providers as IProviders;
  try {
    const group = await graphProvider.getGroup(id);
    if (group) {
      return res.json({
        group,
      });
    } else {
      const notFound = new Error('Not found');
      ErrorHelper.EnsureHasStatus(notFound, 404);
      throw notFound;
    }
  } catch (error) {
    if (ErrorHelper.IsNotFound(error)) {
      return next(jsonError(`group by ID ${id} not found`, 404));
    } else {
      console.dir(error);
      return next(jsonError(error));
    }
  }
}));

router.get('/groups', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const q = req.query.q as string;
  if (!q) {
    return next(jsonError('query required', 400));
  }
  const { graphProvider } = req.app.settings.providers as IProviders;
  try {
    const results = await graphProvider.getGroupsStartingWith(q);
    return res.json({
      groups: results,
    });
  } catch (error) {
    if (ErrorHelper.IsNotFound(error)) {
      return next(jsonError(`search for groups starting with ${q} not found`, 404));
    } else {
      console.dir(error);
      return next(jsonError(error));
    }
  }
}));

router.get('/users', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const q = req.query.q as string;
  const ids = req.query.ids as string;
  if (!q && !ids) {
    return next(jsonError('query required', 400));
  }
  let idArray = ids ? (
    ids.includes(';') ? ids.split(';') : ids.split(',')
  ) : null;
  const { graphProvider } = req.app.settings.providers as IProviders;
  try {
    const results = ids ? (await graphProvider.getUsersByIds(idArray)) : (await graphProvider.getUsersBySearch(q));
    return res.json({
      users: results,
    });
  } catch (error) {
    if (ErrorHelper.IsNotFound(error)) {
      return next(jsonError(`search for users starting with ${q} not found`, 404));
    } else {
      console.dir(error);
      return next(jsonError(error));
    }
  }
}));

router.get('/user/:id', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const id = req.params.id;
  if (!id) {
    return next(jsonError('id required', 400));
  }
  const { graphProvider } = req.app.settings.providers as IProviders;
  try {
    const entry = await graphProvider.getUserById(id);
    if (entry) {
      return res.json({
        user: entry,
      });
    } else {
      const notFound = new Error('Not found');
      ErrorHelper.EnsureHasStatus(notFound, 404);
      throw notFound;
    }
  } catch (error) {
    if (ErrorHelper.IsNotFound(error)) {
      return next(jsonError(`id ${id} not found`, 404));
    } else {
      console.dir(error);
      return next(jsonError(error));
    }
  }
}));

export default router;
