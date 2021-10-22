import express, { Request, Response } from 'express';
import base64url from 'base64url';
import { getNow, csrfCheck, authzAPI } from '../libs/helper';
import { getCredentials, removeCredential, storeCredential } from './credential';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import {
  AttestationConveyancePreference,
  PublicKeyCredentialDescriptor,
  PublicKeyCredentialParameters,
  AuthenticatorDevice,
  RegistrationCredentialJSON,
  AuthenticationCredentialJSON,
} from '@simplewebauthn/typescript-types';

const router = express.Router();

router.use(csrfCheck);

const RP_NAME = process.env.PROJECT_NAME || 'WebAuthn';
const WEBAUTHN_TIMEOUT = 1000 * 60 * 5; // 5 minutes

/**
 * Returns a list of credentials
 **/
router.post('/getCredentials', authzAPI, async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!res.locals.user) throw 'Unauthorized.';

  const user = res.locals.user;

  try {
    const credentials = await getCredentials(user.user_id);
    res.json(credentials);
  } catch (e) {
    res.status(401).json({
      status: false,
      error: 'Unauthorized'
    });
  }
});

// router.post('/renameCredential',
//   authzAPI,
//   body('deviceName').isLength({ min: 3, max: 30 }),
//   async (
//     req: Request,
//     res: Response
//   ): Promise<void> => {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       res.sendStatus(400).json({ status: false, error: 'Invalid device name.' });
//       return;
//     }

//     const user = <User>res.locals.user;
//     const { credId, deviceName } = req.body;

//     // Find the credential with the same credential ID
//     const cred = user?.credentials.find(cred => cred.credentialID === credId);

//     if (user && cred) {
//       // Update the credential's device name.
//       cred.deviceName = deviceName;
//       UserManager.saveUser(user);
//     }
//     res.json({ status: true });
//   }
// );

/**
 * Removes a credential id attached to the user
 * Responds with empty JSON `{}`
 **/
router.post('/removeCredential', authzAPI, async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!res.locals.user) throw 'Unauthorized.';

  const { credId } = req.body;

  try {
    await removeCredential(credId);
    res.json({
      status: true
    });
  } catch (e) {
    res.status(400).json({
      status: false
    });
  }
});

// router.get('/resetDB', (req, res) => {
//   db.set('users', []).write();
//   const users = db.get('users').value();
//   res.json(users);
// });

/**
 * Respond with required information to call navigator.credential.create()
 * Input is passed via `req.body` with similar format as output
 * Output format:
 * ```{
     rp: {
       id: String,
       name: String
     },
     user: {
       displayName: String,
       id: String,
       name: String
     },
     publicKeyCredParams: [{  // @herrjemand
       type: 'public-key', alg: -7
     }],
     timeout: Number,
     challenge: String,
     excludeCredentials: [{
       id: String,
       type: 'public-key',
       transports: [('ble'|'nfc'|'usb'|'internal'), ...]
     }, ...],
     authenticatorSelection: {
       authenticatorAttachment: ('platform'|'cross-platform'),
       requireResidentKey: Boolean,
       userVerification: ('required'|'preferred'|'discouraged')
     },
     attestation: ('none'|'indirect'|'direct')
 * }```
 **/
router.post('/registerRequest', authzAPI, async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    // Unlikely exception
    if (!res.locals.user) throw 'Unauthorized.';

    const user = res.locals.user;

    // Unlikely exception
    if (!process.env.HOSTNAME) throw 'HOSTNAME not configured as an environment variable.';

    const creationOptions = <PublicKeyCredentialCreationOptions>req.body || {};

    const excludeCredentials: PublicKeyCredentialDescriptor[] = [];
    if (creationOptions.excludeCredentials) {
      const credentials = await getCredentials(user.user_id);
      if (credentials.length > 0) {
        for (let cred of credentials) {
          excludeCredentials.push({
            id: base64url.toBuffer(cred.credentialID),
            type: 'public-key',
            transports: cred.transports,
          });
        }
      }
    }
    const pubKeyCredParams: PublicKeyCredentialParameters[] = [];
    // const params = [-7, -35, -36, -257, -258, -259, -37, -38, -39, -8];
    const params = [-7, -257];
    for (let param of params) {
      pubKeyCredParams.push({ type: 'public-key', alg: param });
    }
    const as: AuthenticatorSelectionCriteria = {}; // authenticatorSelection
    const aa = creationOptions.authenticatorSelection?.authenticatorAttachment;
    const rk = creationOptions.authenticatorSelection?.residentKey;
    const uv = creationOptions.authenticatorSelection?.userVerification;
    const cp = creationOptions.attestation; // attestationConveyancePreference
    let asFlag = false;
    let authenticatorSelection;
    let attestation: AttestationConveyancePreference = 'none';

    if (aa && (aa == 'platform' || aa == 'cross-platform')) {
      asFlag = true;
      as.authenticatorAttachment = aa;
    }
    if (rk && (rk == 'required' || rk == 'preferred' || rk == 'discouraged')) {
      asFlag = true;
      as.residentKey = rk;
      as.requireResidentKey = (rk == 'required');
    }
    if (uv && (uv == 'required' || uv == 'preferred' || uv == 'discouraged')) {
      asFlag = true;
      as.userVerification = uv;
    }
    if (asFlag) {
      authenticatorSelection = as;
    }
    if (cp && (cp == 'none' || cp == 'indirect' || cp == 'direct')) {
      attestation = cp;
    }

    // TODO: Validate
    const extensions = creationOptions.extensions;

    const options = generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: process.env.HOSTNAME,
      userID: user.user_id,
      userName: user.name || 'Unnamed User',
      timeout: WEBAUTHN_TIMEOUT,
      // Prompt users for additional information about the authenticator.
      attestationType: attestation,
      // Prevent users from re-registering existing authenticators
      excludeCredentials,
      authenticatorSelection,
      extensions,
    });

    // TODO: Are you sure using AuthenticationSession is a good idea?
    req.session.challenge = options.challenge;
    req.session.timeout = getNow() + WEBAUTHN_TIMEOUT;

    res.json(options);
  } catch (e) {
    res.status(400).send({ status: false, error: e });
  }
});

/**
 * Register user credential.
 * Input format:
 * ```{
     id: String,
     type: 'public-key',
     rawId: String,
     response: {
       clientDataJSON: String,
       attestationObject: String,
       signature: String,
       userHandle: String
     }
 * }```
 **/
router.post('/registerResponse', authzAPI, async (
  req: Request,
  res: Response
) => {
  try {
    // Unlikely exception
    if (!res.locals.user) throw 'Unauthorized.';

    if (!req.session.challenge) throw 'No challenge found.';

    // Unlikely exception
    if (!process.env.HOSTNAME) throw 'HOSTNAME not configured as an environment variable.';
    if (!process.env.ORIGIN) throw 'ORIGIN not configured as an environment variable.';

    const user = res.locals.user;
    const credential = <RegistrationCredentialJSON>req.body;

    const expectedChallenge = req.session.challenge;
    const expectedRPID = process.env.HOSTNAME;

    let expectedOrigin = '';
    const ua = req.get('User-Agent');

    // We don't plan to support Android native FIDO2 authenticators.
    if (ua && ua.indexOf('okhttp') > -1) {
      const hash = process.env.ANDROID_SHA256HASH;
      if (!hash) {
        throw 'ANDROID_SHA256HASH not configured as an environment variable.'
      }
      const octArray = hash.split(':').map(h => parseInt(h, 16));
      // @ts-ignore
      const androidHash = base64url.encode(octArray);
      expectedOrigin = `android:apk-key-hash:${androidHash}`; // TODO: Generate
    } else {
      expectedOrigin = process.env.ORIGIN;
    }

    const verification = await verifyRegistrationResponse({
      credential,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
    });

    const { verified, registrationInfo } = verification;

    if (!verified || !registrationInfo) {
      throw 'User verification failed.';
    }

    const { credentialPublicKey, credentialID, counter } = registrationInfo;
    const base64PublicKey = base64url.encode(credentialPublicKey);
    const base64CredentialID = base64url.encode(credentialID);
    const { transports } = credential;

    const existingCred = await getCredentials(base64CredentialID)

    if (existingCred.length === 0) {
      /*
       * Add the returned device to the user's list of devices
       */
      await storeCredential({
        user_id: user.user_id,
        credentialPublicKey: base64PublicKey,
        credentialID: base64CredentialID,
        counter,
        transports,
        registered: getNow(),
      });
    }

    delete req.session.challenge;
    delete req.session.timeout;

    // Respond with user info
    res.json(credential);
  } catch (e: any) {
    delete req.session.challenge;
    delete req.session.timeout;

    res.status(400).send({ status: false, error: e.message });
  }
});

/**
 * Respond with required information to call navigator.credential.get()
 * Input is passed via `req.body` with similar format as output
 * Output format:
 * ```{
     challenge: String,
     userVerification: ('required'|'preferred'|'discouraged'),
     allowCredentials: [{
       id: String,
       type: 'public-key',
       transports: [('ble'|'nfc'|'usb'|'internal'), ...]
     }, ...]
 * }```
 **/
router.post('/authRequest', authzAPI, async (
  req: Request,
  res: Response
) => {
  // Unlikely exception
  if (!res.locals.user) throw 'Unauthorized.';

  try {
    const user = res.locals.user;

    const credId = req.query.credId;
    // TODO: Define expected type
    const requestOptions = req.body;

    const userVerification = requestOptions.userVerification || 'preferred';
    const allowCredentials: PublicKeyCredentialDescriptor[] = [];

    if (!requestOptions.emptyAllowCredentials) {
      const credentials = await getCredentials(user.user_id);
      for (let cred of credentials) {
        // When credId is not specified, or matches the one specified
        if (!credId || cred.credentialID == credId) {
          allowCredentials.push({
            id: base64url.toBuffer(cred.credentialID),
            type: 'public-key',
            transports: cred.transports
          });
        }
      }
    }

    const options = generateAuthenticationOptions({
      timeout: WEBAUTHN_TIMEOUT,
      allowCredentials,
      userVerification,
    });

    req.session.challenge = options.challenge;
    req.session.timeout = getNow() + WEBAUTHN_TIMEOUT;

    res.json(options);
  } catch (e) {
    res.status(400).json({ status: false, error: e });
  }
});

/**
 * Authenticate the user.
 * Input format:
 * ```{
     id: String,
     type: 'public-key',
     rawId: String,
     response: {
       clientDataJSON: String,
       authenticatorData: String,
       signature: String,
       userHandle: String
     }
 * }```
 **/
router.post('/authResponse', authzAPI, async (
  req: Request,
  res: Response
) => {
  // Unlikely exception
  if (!res.locals.user) throw 'Unauthorized.';

  // Unlikely exception
  if (!process.env.HOSTNAME) throw 'HOSTNAME not configured as an environment variable.';
  if (!process.env.ORIGIN) throw 'ORIGIN not configured as an environment variable.';

  const user = res.locals.user;
  const expectedChallenge = req.session.challenge || '';
  const expectedRPID = process.env.HOSTNAME;
  const expectedOrigin = process.env.ORIGIN;

  try {
    const claimedCred = <AuthenticationCredentialJSON>req.body;

    const credentials = await getCredentials(user.user_id);
    let storedCred = credentials.find((cred) => cred.credentialID === claimedCred.id);

    if (!storedCred) {
      throw 'Authenticating credential not found.';
    }

    const base64PublicKey = base64url.toBuffer(storedCred.credentialPublicKey);
    const base64CredentialID = base64url.toBuffer(storedCred.credentialID);
    const { counter, transports } = storedCred; 

    const authenticator: AuthenticatorDevice = {
      credentialPublicKey: base64PublicKey,
      credentialID: base64CredentialID,
      counter,
      transports
    }

    const verification = verifyAuthenticationResponse({
      credential: claimedCred,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      authenticator,
    });

    const { verified, authenticationInfo } = verification;

    if (!verified) {
      throw 'User verification failed.';
    }

    storedCred.counter = authenticationInfo.newCounter;
    storedCred.last_used = getNow();

    delete req.session.challenge;
    delete req.session.timeout;
    res.json(storedCred);
  } catch (e) {
    delete req.session.challenge;
    delete req.session.timeout;
    res.status(400).json({ status: false, error: e });
  }
});

export { router as webauthn };
