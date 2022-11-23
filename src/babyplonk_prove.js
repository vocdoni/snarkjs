/*
    Copyright 2022 iden3 association.

    This file is part of snarkjs.

    snarkjs is a free software: you can redistribute it and/or
    modify it under the terms of the GNU General Public License as published by the
    Free Software Foundation, either version 3 of the License, or (at your option)
    any later version.

    snarkjs is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
    more details.

    You should have received a copy of the GNU General Public License along with
    snarkjs. If not, see <https://www.gnu.org/licenses/>.
*/

import * as binFileUtils from "@iden3/binfileutils";
import * as zkeyUtils from "./zkey_utils.js";
import * as wtnsUtils from "./wtns_utils.js";
import {Scalar, utils, BigBuffer} from "ffjavascript";
import {BABY_PLONK_PROTOCOL_ID} from "./zkey.js";
import {
    BP_A_MAP_ZKEY_SECTION,
    BP_ADDITIONS_ZKEY_SECTION, BP_K_ZKEY_SECTION, BP_LAGRANGE_ZKEY_SECTION,
    BP_PTAU_ZKEY_SECTION, BP_Q_ZKEY_SECTION,
    BP_SIGMA_ZKEY_SECTION
} from "./babyplonk.js";
import {Keccak256Transcript} from "./Keccak256Transcript.js";
import {Proof} from "./proof.js";
import {mul2, mul3} from "./mul_z.js";
import {Polynomial} from "./polynomial/polynomial.js";
import {Evaluations} from "./polynomial/evaluations.js";

const {stringifyBigInts} = utils;

export default async function babyPlonkProve(zkeyFileName, witnessFileName, logger) {
    if (logger) logger.info("Baby Plonk prover started");

    // Read witness file
    if (logger) logger.info("Reading witness file");
    const {
        fd: fdWtns,
        sections: wtnsSections
    } = await binFileUtils.readBinFile(witnessFileName, "wtns", 2, 1 << 25, 1 << 23);
    const wtns = await wtnsUtils.readHeader(fdWtns, wtnsSections);

    //Read zkey file
    if (logger) logger.info("Reading zkey file");
    const {
        fd: fdZKey,
        sections: zkeySections
    } = await binFileUtils.readBinFile(zkeyFileName, "zkey", 2, 1 << 25, 1 << 23);
    const zkey = await zkeyUtils.readHeader(fdZKey, zkeySections);

    if (zkey.protocolId !== BABY_PLONK_PROTOCOL_ID) {
        throw new Error("zkey file is not Baby Plonk");
    }

    if (!Scalar.eq(zkey.r, wtns.q)) {
        throw new Error("Curve of the witness does not match the curve of the proving key");
    }

    if (wtns.nWitness !== zkey.nVars - zkey.nAdditions) {
        throw new Error(`Invalid witness length. Circuit: ${zkey.nVars}, witness: ${wtns.nWitness}, ${zkey.nAdditions}`);
    }

    const curve = zkey.curve;

    const Fr = curve.Fr;
    const G1 = curve.G1;

    const sFr = curve.Fr.n8;
    const sG1 = curve.G1.F.n8 * 2;
    const sDomain = zkey.domainSize * sFr;

    //Read witness data
    if (logger) logger.debug("Reading witness data");
    const buffWitness = await binFileUtils.readSection(fdWtns, wtnsSections, 2);
    // First element in plonk is not used and can be any value. (But always the same).
    // We set it to zero to go faster in the exponentiations.
    buffWitness.set(Fr.zero, 0);
    const buffInternalWitness = new BigBuffer(sFr * zkey.nAdditions);

    let buffers = {};
    let polynomials = {};
    let evaluations = {};
    const challenges = {};

    let proof = new Proof(curve, logger);

    if (logger) logger.info(`Reading Section ${BP_ADDITIONS_ZKEY_SECTION}. Additions`);
    await calculateAdditions();

    if (logger) logger.info(`Reading Section ${BP_SIGMA_ZKEY_SECTION}. Sigma1+Sigma2`);
    // Get sigma1 & sigma2 evaluations from zkey file
    evaluations.sigma = new Evaluations(new BigBuffer(sDomain * 4 * 2), Fr, logger);

    //Read sigma1 evaluations into sigma first half
    let offset = zkeySections[BP_SIGMA_ZKEY_SECTION][0].p + sDomain;
    await fdZKey.readToBuffer(evaluations.sigma.eval, 0, sDomain * 4, offset);

    //Read sigma2 evaluations into sigma second half
    offset += sDomain * 5;
    await fdZKey.readToBuffer(evaluations.sigma, sDomain * 4, sDomain * 4, offset);

    // Get polynomial S1, polynomial S2 will be read on round4, when it's necessary
    polynomials.S1 = new Polynomial(new BigBuffer(sDomain), Fr, logger);
    await fdZKey.readToBuffer(polynomials.S1.coef, 0, sDomain, zkeySections[BP_SIGMA_ZKEY_SECTION][0].p);

    if (logger) logger.info(`Reading Section ${BP_PTAU_ZKEY_SECTION}. Powers of Tau`);
    const PTau = await binFileUtils.readSection(fdZKey, zkeySections, BP_PTAU_ZKEY_SECTION);

    // Start baby plonk protocol

    // ROUND 1. Compute polynomials A(X) and B(X)
    await round1();

    // ROUND 2. Compute permutation polynomial Z(X)
    await round2();

    // ROUND 3. Compute quotient polynomial t(X)
    await round3();

    // ROUND 4. Compute evaluations
    await round4();

    // ROUND 5. Compute linearisation polynomial r(X)
    await round5();

    await fdZKey.close();
    await fdWtns.close();

    let publicSignals = [];

    for (let i = 1; i <= zkey.nPublic; i++) {
        const i_sFr = i * sFr;

        const pub = buffWitness.slice(i_sFr, i_sFr + sFr);
        publicSignals.push(Scalar.fromRprLE(pub));
    }

    let _proof = proof.toObjectProof();
    _proof.protocol = "baby_plonk";
    _proof.curve = curve.name;

    return {proof: stringifyBigInts(_proof), publicSignals: stringifyBigInts(publicSignals)};

    async function calculateAdditions() {
        const additionsBuff = await binFileUtils.readSection(fdZKey, zkeySections, BP_ADDITIONS_ZKEY_SECTION);

        // sizes: wireId_x = 4 bytes (32 bits), factor_x = field size bits
        // Addition form: wireId_a wireId_b factor_a factor_b (size is 4 + 4 + sFr + sFr)
        const sSum = 8 + sFr * 2;

        for (let i = 0; i < zkey.nAdditions; i++) {
            // Read addition values
            let offset = i * sSum;
            const signalId1 = readUInt32(additionsBuff, offset);
            offset += 4;
            const signalId2 = readUInt32(additionsBuff, offset);
            offset += 4;
            const factor1 = additionsBuff.slice(offset, offset + sFr);
            offset += sFr;
            const factor2 = additionsBuff.slice(offset, offset + sFr);

            // Get witness value
            const witness1 = getWitness(signalId1);
            const witness2 = getWitness(signalId2);

            //Calculate final result
            const result = Fr.add(Fr.mul(factor1, witness1), Fr.mul(factor2, witness2));

            buffInternalWitness.set(result, sFr * i);
        }
    }

    async function buildABEvaluationsBuffer() {
        buffers.A = new BigBuffer(sDomain);
        buffers.B = new BigBuffer(sDomain);

        const aMapBuff = await binFileUtils.readSection(fdZKey, zkeySections, BP_A_MAP_ZKEY_SECTION);
        const bMapBuff = await binFileUtils.readSection(fdZKey, zkeySections, BP_B_MAP_ZKEY_SECTION);
        const kBuff = await binFileUtils.readSection(fdZKey, zkeySections, BP_K_ZKEY_SECTION);

        for (let i = 0; i < zkey.nConstraints; i++) {
            const offset1 = i * 4;
            const offset2 = i * sFr;

            // Compute A value from signal id
            const signalIdA = readUInt32(aMapBuff, offset1);
            buffers.A.set(getWitness(signalIdA), offset2);

            // Compute B value from signal id
            const signalIdB = readUInt32(bMapBuff, offset1);
            let b = getWitness(signalIdB);

            // When is an odd row it means the value we're taking is b'.
            // We set b' as negative to fit the equation
            if (i % 2 !== 0) {
                b = Fr.neg(b);
            }

            // We add to b or b' the constant value saved in the setup process
            const k = kBuff.slice(offset2, offset2 + sFr);
            b = Fr.add(b, k);

            buffers.B.set(getWitness(signalIdB), offset2);
        }

        buffers.A = await Fr.batchToMontgomery(buffers.A);
        buffers.B = await Fr.batchToMontgomery(buffers.B);
    }

    function readUInt32(b, o) {
        const buff = b.slice(o, o + 4);
        const buffV = new DataView(buff.buffer, buff.byteOffset, buff.byteLength);
        return buffV.getUint32(0, true);
    }

    function getWitness(idx) {
        let diff = zkey.nVars - zkey.nAdditions;
        if (idx < diff) {
            return buffWitness.slice(idx * sFr, idx * sFr + sFr);
        } else if (idx < zkey.nVars) {
            const offset = (idx - diff) * sFr;
            return buffInternalWitness.slice(offset, offset + sFr);
        } else {
            return Fr.zero;
        }
    }

    async function round1() {
        // 1. Generate random blinding scalars (b_1, ..., b8) ∈ F
        challenges.b = [];
        for (let i = 1; i <= 8; i++) {
            challenges.b[i] = Fr.random();
        }

        // 2. Build A, B evaluations buffer from zkey and witness files
        await buildABEvaluationsBuffer();

        // 3. Compute wire polynomials a, b and their extended evaluations
        polynomials.A = Polynomial.fromBuffer(buffers.A, Fr, logger);
        polynomials.B = Polynomial.fromBuffer(buffers.B, Fr, logger);

        evaluations.A = Evaluations.fromPolynomial(polynomials.A, Fr, logger);
        evaluations.B = Evaluations.fromPolynomial(polynomials.B, Fr, logger);

        polynomials.A.blindCoefficients([challenges.b[1], challenges.b[2]]);
        polynomials.B.blindCoefficients([challenges.b[3], challenges.b[4]]);

        // TODO check degrees for polynomials.A & polynomials.B
        //if (polynomials.A.degree() >= DOMAIN_SIZE + X) {
        //    throw new Error("A Polynomial is not well calculated");
        //}

        // 4. The first output of the prover is ([a]_1, [b]_1)
        proof.addPolynomial("A", await multiExponentiation(polynomials.A, "A"));
        proof.addPolynomial("B", await multiExponentiation(polynomials.B, "B"));
    }

    async function round2() {
        // 1. Compute the permutation challenge gamma ∈ F_p:
        const transcript = new Keccak256Transcript(curve);
        for (let i = 0; i < zkey.nPublic; i++) {
            transcript.addScalar(evaluations.A.slice(i * sFr, (i + 1) * sFr));
        }
        transcript.addPolCommitment(proof.getPolynomial("A"));
        transcript.addPolCommitment(proof.getPolynomial("B"));

        challenges.beta = transcript.getChallenge();
        if (logger) logger.debug("Challenge.beta: " + Fr.toString(challenges.beta));

        // Compute permutation challenge gamma
        transcript.reset();
        transcript.addScalar(challenges.beta);
        challenges.gamma = transcript.getChallenge();
        if (logger) logger.debug("Challenge.gamma: " + Fr.toString(challenges.gamma));

        // 2. Compute permutation polynomial Z(X)
        let numArr = new BigBuffer(sDomain);
        let denArr = new BigBuffer(sDomain);

        numArr.set(Fr.one, 0);
        denArr.set(Fr.one, 0);

        // Set initial omega
        let w = Fr.one;
        for (let i = 0; i < zkey.domainSize; i++) {
            const i_sFr = i * sFr;
            const i_sDomain = (zkey.domainSize + i) * sFr;

            let num1 = evaluations.A.slice(i_sFr, i_sFr + sFr);
            num1 = Fr.add(num1, Fr.mul(challenges.beta, w));
            num1 = Fr.add(num1, challenges.gamma);

            let num2 = evaluations.B.slice(i_sFr, i_sFr + sFr);
            num2 = Fr.add(num2, Fr.mul(zkey.k1, Fr.mul(challenges.beta, w)));
            num2 = Fr.add(num2, challenges.gamma);

            const num = Fr.mul(num1, num2);

            let den1 = evaluations.A.slice(i_sFr, i_sFr + sFr);
            den1 = Fr.add(den1, Fr.mul(evaluations.sigma.slice(i_sFr * 4, i_sFr * 4 + sFr), challenges.beta));
            den1 = Fr.add(den1, challenges.gamma);

            let den2 = evaluations.B.slice(i_sFr, i_sFr + sFr);
            den2 = Fr.add(den2, Fr.mul(evaluations.sigma.slice(i_sDomain * 4, i_sDomain * 4 + sFr), challenges.beta));
            den2 = Fr.add(den2, challenges.gamma);

            const den = Fr.mul(den1, den2);

            numArr.set(
                Fr.mul(numArr.slice(i_sFr, i_sFr + sFr), num),
                ((i + 1) % zkey.domainSize) * sFr
            );

            denArr.set(
                Fr.mul(denArr.slice(i_sFr, i_sFr + sFr), den),
                ((i + 1) % zkey.domainSize) * sFr
            );

            w = Fr.mul(w, Fr.w[zkey.power]);
        }

        denArr = await Fr.batchInverse(denArr);

        // TODO: Do it in assembly and in parallel
        for (let i = 0; i < zkey.domainSize; i++) {
            const i_sFr = i * sFr;

            const z = Fr.mul(numArr.slice(i_sFr, i_sFr + sFr), denArr.slice(i_sFr, i_sFr + sFr));
            numArr.set(z, i_sFr);
        }
        buffers.Z = numArr;

        if (!Fr.eq(numArr.slice(0, sFr), Fr.one)) {
            throw new Error("Copy constraints does not match");
        }

        polynomials.Z = await Polynomial.fromBuffer(buffers.Z, Fr, logger);
        evaluations.Z = await Evaluations.fromPolynomial(polynomials.Z, Fr, logger);

        // blind z(X) adding (b_8X^2+b_9X+b_10)Z_H(X), becomes F_{<n+3}[X]
        polynomials.Z.blindCoefficients([challenges.b[5], challenges.b[6], challenges.b[7]]);

        // TODO check degrees for polynomials.Z
        //if (polynomials.Z.degree() >= DOMAIN_SIZE + 3) {
        //    throw new Error("range_check: Z Polynomial is not well calculated");
        //}

        // 3. The second output of the prover is ([z(x)]_1)
        proof.addPolynomial("Z", await multiExponentiation(polynomials.Z, "Z"));
    }

    async function round3() {
        // 1. Compute the quotient challenge alpha
        const transcript = new Keccak256Transcript(curve);
        transcript.addPolCommitment(proof.getPolynomial("Z"));
        challenges.alpha = transcript.getChallenge();
        if (logger) logger.debug("Challenge.alpha: " + Fr.toString(challenges.alpha));

        // 2. Compute the quotient polynomial q(X) ∈ F[X]
        if (logger) logger.debug("Reading Q1");
        evaluations.Q1 = new Evaluations(BigBuffer(sDomain * 4), Fr, logger);
        await fdZKey.readToBuffer(evaluations.Q1, 0, sDomain * 4, zkeySections[BP_Q_ZKEY_SECTION][0].p + sDomain);

        if (logger) logger.debug("Reading Q2");
        evaluations.Q2 = new Evaluations(new BigBuffer(sDomain * 4), Fr, logger);
        await fdZKey.readToBuffer(evaluations.Q2, 0, sDomain * 4, zkeySections[BP_Q2_ZKEY_SECTION][0].p + sDomain);

        if (logger) logger.debug("Reading Lagrange polynomials");
        const lagrange1 = await binFileUtils.readSection(fdZKey, zkeySections, BP_LAGRANGE_ZKEY_SECTION);
        evaluations.lagrange1 = new Evaluations(lagrange1, Fr, logger);

        const buffT = new BigBuffer(sDomain * 4);
        const buffTz = new BigBuffer(sDomain * 4);

        const alphaSquared = Fr.square(challenges.alpha);

        // Set initial omega
        let omega = Fr.one;
        for (let i = 0; i < zkey.domainSize * 4; i++) {
            if ((i % 5000 === 0) && (logger)) logger.debug(`calculating t ${i}/${zkey.domainSize * 4}`);

            const i_sFr = i * sFr;
            const i_sFrw = ((i + zkey.domainSize * 4 + 4) % (zkey.domainSize * 4)) * sFr;
            const i_sDomain = (zkey.domainSize * 4 + i) * sFr;

            const omega2 = Fr.square(omega);
            const omegaW = Fr.mul(omega, Fr.w[zkey.power]);
            const omegaW2 = Fr.square(omegaW);

            const a = evaluations.A.get(i_sFr);
            const b = evaluations.B.get(i_sFr);
            const q1 = evaluations.Q1.get(i_sFr);
            const q2 = evaluations.Q2.get(i_sFr);
            const z = evaluations.Z.get(i_sFr);

            const aW = evaluations.A.get(i_sFrw);
            const bW = evaluations.B.get(i_sFrw);
            const q1W = evaluations.Q1.get(i_sFrw);
            const q2W = evaluations.Q2.get(i_sFrw);
            const zW = evaluations.Z.get(i_sFrw);


            const s1 = evaluations.sigma.get(i_sFr);
            const s2 = evaluations.sigma.get(i_sDomain);

            const ap = Fr.add(Fr.mul(challenges.b[1], omega), challenges.b[2]);
            const bp = Fr.add(Fr.mul(challenges.b[3], omega), challenges.b[4]);

            const zp = Fr.add(Fr.add(Fr.mul(challenges.b[5], omega2), Fr.mul(challenges.b[6], omega)), challenges.b[7]);
            const zWp = Fr.add(Fr.add(Fr.mul(challenges.b[5], omegaW2), Fr.mul(challenges.b[6], omegaW)), challenges.b[7]);

            let pl = Fr.zero;
            for (let j = 0; j < zkey.nPublic; j++) {
                const offset = (j * 5 * zkey.domainSize + zkey.domainSize + i) * sFr;

                const lPol = evaluations.lagrange1.get(offset);
                const aVal = evaluations.A.get(j * sFr);

                pl = Fr.sub(pl, Fr.mul(lPol, aVal));
            }

            // GATE CONSTRAINT
            // IDENTITY A) q_1·a + q_2·b + q_1'·a·b + q_2'·a·a' + b' = 0
            let identityA = Fr.zero;
            let identityAz = Fr.zero;
            if (i % 2 === 0) {
                const idA0 = Fr.mul(a, q1);
                const idA0z = Fr.mul(ap, q1);

                const idA1 = Fr.mul(b, q2);
                const idA1z = Fr.mul(bp, q2);

                let [idA2, idA2z] = mul2(a, b, ap, bp, i % 4);
                idA2 = Fr.mul(idA2, q1W);
                idA2z = Fr.mul(idA2z, q1W);

                let [idA3, idA3z] = mul2(a, aW, ap, bp, i % 4);
                idA3 = Fr.mul(idA3, q2W);
                idA3z = Fr.mul(idA3z, q2W);

                identityA = Fr.add(idA0, Fr.add(idA1, Fr.add(idA2, Fr.add(idA3, bW))));
                identityAz = Fr.add(idA0z, Fr.add(idA1z, Fr.add(idA2z, idA3z))); //TODO check if we have to add something like bWz
            }

            // PERMUTATION CONSTRAINT
            // IDENTITY B = B1 - B2

            // IDENTITY B1) (a(X) + beta·X + gamma)(b(X) + beta·k1·X + gamma)z(X)
            const betaX = Fr.mul(challenges.beta, omega);
            let idB11 = Fr.add(a, betaX);
            idB11 = Fr.add(idB11, challenges.gamma);

            let idB12 = Fr.add(b, Fr.mul(betaX, zkey.k1));
            idB12 = Fr.add(idB12, challenges.gamma);

            const [identityB1, identityB1z] = mul3(idB11, idB12, z, ap, bp, zp, i % 4);

            // IDENTITY B2) (a(X) + beta·sigma1(X) + gamma) (b(X) + beta·sigma2(X) + gamma) z(Xω)
            let idB21 = a;
            idB21 = Fr.add(idB21, Fr.mul(challenges.beta, s1));
            idB21 = Fr.add(idB21, challenges.gamma);

            let idB22 = b;
            idB22 = Fr.add(idB22, Fr.mul(challenges.beta, s2));
            idB22 = Fr.add(idB22, challenges.gamma);

            const [identityB2, identityB2z] = mul3(idB21, idB22, zW, ap, bp, zWp, i % 4);

            let identityB = Fr.sub(identityB1, identityB2);
            let identityBz = Fr.sub(identityB1z, identityB2z);

            // IDENTITY C) (z(X)-1) · L_1(X)
            const offset = (zkey.domainSize + i) * sFr;
            let identityC = Fr.mul(Fr.sub(z, Fr.one), evaluations.lagrange1.slice(offset, offset + sFr));
            let identityCz = Fr.mul(zp, evaluations.lagrange1.slice(offset, offset + sFr));

            // Apply alpha random factor
            identityB = Fr.mul(identityB, challenges.alpha);
            identityC = Fr.mul(identityC, alphaSquared);

            identityBz = Fr.mul(identityBz, challenges.alpha);
            identityCz = Fr.mul(identityCz, alphaSquared);

            let identities = identityA;
            identities = Fr.add(identities, identityB);
            identities = Fr.add(identities, identityC);

            let identitiesZ = identityAz;
            identitiesZ = Fr.add(identitiesZ, identityBz);
            identitiesZ = Fr.add(identitiesZ, identityCz);

            // Set T & Tz values
            buffT.set(identities, i * sFr);
            buffTz.set(identitiesZ, i * sFr);

            // Compute next omega
            omega = Fr.mul(omega, Fr.w[zkey.power + 2]);
        }

        delete evaluations.Q1;
        delete evaluations.Q2;
        delete evaluations.lagrange1;

        if (logger) logger.debug("ifft T");
        polynomials.T = await Polynomial.fromBuffer(buffT, Fr, logger);
        polynomials.T = await polynomials.T.divZh();

        if (logger) logger.debug("ifft Tz");
        const polTz = await Polynomial.fromBuffer(buffTz, Fr, logger);

        polynomials.T.add(polTz);

        //TODO
        //const expectedDegree = 1 === C ? 2 * DOMAIN_SIZE + 5 : C * (DOMAIN_SIZE + 2) + 3;
        //if (polynomials.T.degree() > expectedDegree) {
        //    throw new Error("range_check Q Polynomial is not well calculated");
        //}

        // 3. Split t(X) into 2 polynomials
        // of degree lower than n+3 and another polynomial q'_c(X) of degree at most n+4
        polynomials.splitT = polynomials.T.split(2, zkey.domainSize, challenges.b[8]);

        // 4. The third output of the prover is ([q_1(x)]_1, ..., [q_{c-1}(x)]_1, [q_c(x)]_1)
        proof.addPolynomial("TL", await multiExponentiation(polynomials.splitT[0], "TL"));
        proof.addPolynomial("TH", await multiExponentiation(polynomials.splitT[1], "TH"));
    }

    async function round4() {
        // 1. Compute evaluation challenge xi ∈ F_p
        const transcript = new Keccak256Transcript(curve);
        transcript.addPolCommitment(proof.getPolynomial("TL"));
        transcript.addPolCommitment(proof.getPolynomial("TH"));
        challenges.xi = transcript.getChallenge();
        if (logger) logger.debug("Challenge.xi: " + Fr.toString(challenges.xi));

        // 2. Compute the opening evaluations
        proof.addEvaluation("a", polynomials.A.evaluate(challenges.xi));
        proof.addEvaluation("b", polynomials.B.evaluate(challenges.xi));
        proof.addEvaluation("s1", polynomials.S1.evaluate(challenges.xi));
        // TODO Can we remove it?
        proof.addEvaluation("t", polynomials.T.evaluate(challenges.xi));

        const xiw = Fr.mul(challenges.xi, Fr.w[zkey.power]);
        proof.addEvaluation("aw", polynomials.A.evaluate(xiw));
        proof.addEvaluation("bw", polynomials.B.evaluate(xiw));
        proof.addEvaluation("zw", polynomials.Z.evaluate(xiw));
    }

    async function round5() {
        // 1. Compute opening challenges v, vp ∈ F_p
        const transcript = new Keccak256Transcript(curve);
        transcript.addScalar(proof.getEvaluation("a"));
        transcript.addScalar(proof.getEvaluation("b"));
        transcript.addScalar(proof.getEvaluation("s1"));
        transcript.addScalar(proof.getEvaluation("aw"));
        transcript.addScalar(proof.getEvaluation("bw"));
        transcript.addScalar(proof.getEvaluation("zw"));

        challenges.v = [];
        challenges.v[0] = transcript.getChallenge();
        if (logger) logger.debug("Challenge.v: " + Fr.toString(challenges.v[0]));
        for (let i = 1; i <= 3; i++) challenges.v[i] = Fr.mul(challenges.v[i - 1], challenges.v[0]);

        transcript.reset();
        transcript.appendScalar(challenges.v[0]);
        challenges.vp = [];
        challenges.vp[0] = transcript.getChallenge();
        for (let i = 1; i <= 1; i++) challenges.vp[i] = Fr.mul(challenges.vp[i - 1], challenges.vp[0]);

        // 2. Compute the linearisation polynomial r(x) ∈ F_{<n+5}[X]

        // Compute xi^n
        challenges.xiN = challenges.xi;
        for (let i = 0; i < zkey.power; i++) {
            challenges.xiN = Fr.square(challenges.xiN);
        }

        // Get polynomials q1. q2 and sigma2 from zkey file
        polynomials.Q1 = new Polynomial(new BigBuffer(sDomain), Fr, logger);
        await fdZKey.readToBuffer(polynomials.Q1.coef, 0, sDomain, zkeySections[BP_Q_ZKEY_SECTION][0].p);

        polynomials.Q2 = new Polynomial(new BigBuffer(sDomain), Fr, logger);
        await fdZKey.readToBuffer(polynomials.Q2.coef, 0, sDomain, zkeySections[BP_Q2_ZKEY_SECTION][0].p);

        polynomials.S2 = new Polynomial(new BigBuffer(sDomain), Fr, logger);
        await fdZKey.readToBuffer(polynomials.S2.coef, 0, sDomain, zkeySections[BP_SIGMA_ZKEY_SECTION][0].p + 5 * sDomain);

        // precompute evaluation.a * evaluation.b to use inside the loop
        const coefAB = Fr.mul(proof.getEvaluation("a"), proof.getEvaluation("b"));

        // precompute evaluation.a * evaluation.a' to use inside the loop
        const coefAAw = Fr.mul(proof.getEvaluation("a"), proof.getEvaluation("aw"));

        // precompute constant coefficient of z(x) to use inside the loop
        // (evaluations.a + beta·xi + gamma)·(evaluations.b + beta·xi·k1 + gamma)·alpha + L_1(xi)·alpha^2
        const betaxi = Fr.mul(challenges.beta, challenges.xi);

        let part10 = proof.getEvaluation("a");
        part10 = Fr.add(part10, betaxi);
        part10 = Fr.add(part10, challenges.gamma);

        let part11 = proof.getEvaluation("b");
        part11 = Fr.add(part11, Fr.mul(betaxi, zkey.k1));
        part11 = Fr.add(part11, challenges.gamma);

        const part1 = Fr.mul(Fr.mul(part10, part11), challenges.alpha);

        const evalL1 = Fr.div(
            Fr.sub(challenges.xiN, Fr.one),
            Fr.mul(Fr.sub(challenges.xi, Fr.one), Fr.e(zkey.domainSize))
        );

        const part2 = Fr.mul(evalL1, Fr.square(challenges.alpha));

        const coefZ = Fr.add(part1, part2);

        // precompute constant coefficient S2 to use inside the loop
        let coefS2 = proof.getEvaluation("a");
        coefS2 = Fr.add(coefS2, Fr.mul(challenges.beta, proof.getEvaluation("s1")));
        coefS2 = Fr.add(coefS2, challenges.gamma);

        coefS2 = Fr.mul(coefS2, challenges.beta);
        coefS2 = Fr.mul(coefS2, proof.evaluations.zw);
        coefS2 = Fr.mul(coefS2, challenges.alpha);

        let coefficientsR = new BigBuffer((zkey.domainSize + 3) * sFr);

        for (let i = 0; i < zkey.domainSize + 3; i++) {
            const i_sFr = i * sFr;
            const i_sFrw = ((i + zkey.domainSize + 4) % (zkey.domainSize)) * sFr;

            let coefficient = Fr.mul(coefZ, polynomials.Z.getCoef(i_sFr));

            if (i < zkey.domainSize) {
                if (i % 2 === 0) {
                    coefficient = Fr.add(coefficient, Fr.mul(proof.getEvaluation("a"), polynomials.Q1.getCoef(i_sFr)));
                    coefficient = Fr.add(coefficient, Fr.mul(proof.getEvaluation("b"), polynomials.Q2.getCoef(i_sFr)));
                    coefficient = Fr.add(coefficient, Fr.mul(coefAB, polynomials.Q1.getCoef(i_sFrw)));
                    coefficient = Fr.add(coefficient, Fr.mul(coefAAw, polynomials.Q2.getCoef(i_sFrw)));
                }

                coefficient = Fr.sub(coefficient, Fr.mul(coefS2, polynomials.S2.getCoef(i_sFr)));
            }
            coefficientsR.set(coefficient, i_sFr);
        }

        polynomials.R = new Polynomial(coefficientsR, Fr, logger);

        // TODO check degree
        //if (polynomials.R.degree() >= DOMAIN_SIZE + 5) {
        //    throw new Error("range_check R Polynomial is not well calculated");
        //}

        const eval_r = polynomials.R.evaluate(challenges.xi);

        // TODO Compute xi^{n+2} to add to the split polynomial
        let xinAdd2 = Fr.mul(Fr.mul(Fr.mul(challenges.xiN, challenges.xi), challenges.xi), challenges.xi);
        polynomials.splitT[1].mulScalar(xinAdd2);

        // 3.1 Compute the opening proof polynomials W_xi(X) ∈ F_{<n+4}[X]
        //TODO set to correct size value
        polynomials.Wxi = new Polynomial(new BigBuffer(sDomain), Fr, logger);
        polynomials.Wxi.add(polynomials.splitT[0]);
        polynomials.Wxi.add(polynomials.splitT[1]);
        // TODO S'ha d'afegir R????
        polynomials.Wxi.add(polynomials.R, challenges.v[0]);
        polynomials.Wxi.add(polynomials.A, challenges.v[1]);
        polynomials.Wxi.add(polynomials.B, challenges.v[2]);
        polynomials.Wxi.add(polynomials.S1, challenges.v[3]);

        const evaluation_t = polynomials.T.evaluate(challenges.xi);

        polynomials.Wxi.subScalar(evaluation_t);
        polynomials.Wxi.subScalar(Fr.mul(eval_r, challenges.v[0],));
        polynomials.Wxi.subScalar(Fr.mul(proof.getEvaluation("a"), challenges.v[1]));
        polynomials.Wxi.subScalar(Fr.mul(proof.getEvaluation("b"), challenges.v[2]));
        polynomials.Wxi.subScalar(Fr.mul(proof.getEvaluation("s1", challenges.v[3])));

        polynomials.Wxi.divByXValue(challenges.xi);

        //TODO
        //const expectedDegree = 1 === C ? 2 * DOMAIN_SIZE + 5 : DOMAIN_SIZE + 5;
        //if (polynomials.Wxi.degree() > expectedDegree) {
        //    throw new Error("range_check Wxi Polynomial is not well calculated");
        //}

        // 3.2 Compute the opening proof polynomials W_xiω(X) ∈ F_{<n+2}[X]
        polynomials.Wxiw = new Polynomial(polynomials.Z.coef.slice(), Fr, logger);
        polynomials.Wxiw.add(polynomials.A, challenges.vp[0]);
        polynomials.Wxiw.add(polynomials.B, challenges.vp[1]);

        polynomials.Wxiw.subScalar(proof.getEvaluation("zw"));
        polynomials.Wxiw.subScalar(Fr.mul(proof.getEvaluation("aw"), challenges.vp[0]));
        polynomials.Wxiw.subScalar(Fr.mul(proof.getEvaluation("bw"), challenges.vp[1],));

        polynomials.Wxiw.divByXValue(Fr.mul(challenges.xi, Fr.w[zkey.cirPower]));

        // Cal??????
        proof.addEvaluation("r", eval_r);

        //TODO
        //if (polynomials.Wxiw.degree() >= DOMAIN_SIZE + 2) {
        //    throw new Error("range_check Wxiw Polynomial is not well calculated");
        //}

        // 4. The fifth output of the prover is ([W_xi(x)]_1, [W_xiω(x)]_1)
        proof.addPolynomial("Wxi", await multiExponentiation(polynomials.Wxi, "Wxi"));
        proof.addPolynomial("Wxiw", await multiExponentiation(polynomials.Wxiw, "Wxiw"));
    }

    async function multiExponentiation(polynomial, name) {
        const n = polynomial.coef.byteLength / sFr;
        const PTauN = PTau.slice(0, n * sG1);
        const bm = await Fr.batchFromMontgomery(polynomial.coef);
        let res = await G1.multiExpAffine(PTauN, bm, logger, name);
        res = G1.toAffine(res);
        return res;
    }
}



