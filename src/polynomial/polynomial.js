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

import {BigBuffer} from "ffjavascript";

export class Polynomial {
    constructor(coefficients = new Uint8Array(0), domainSize, Fr, logger) {
        this.coeff = coefficients;
        this.domainSize = domainSize;
        this.Fr = Fr;
        this.logger = logger;
    }

    static async fromBuffer(buffer, Fr, logger) {
        let coefficients = await Fr.ifft(buffer);

        return new Polynomial(coefficients, Fr, logger);
    }

    blindCoefficients(blindingFactors) {
        blindingFactors = blindingFactors || [];

        const blindedCoefficients = new BigBuffer((this.length + blindingFactors.length) * this.Fr.n8);
        blindedCoefficients.set(this.coeff, 0);
        for (let i = 0; i < blindingFactors.length; i++) {
            blindedCoefficients.set(
                this.Fr.add(
                    blindedCoefficients.slice((this.length + i) * this.Fr.n8, (this.length + i + 1) * this.Fr.n8),
                    blindingFactors[i]
                ),
                (this.length + i) * this.Fr.n8
            );
            blindedCoefficients.set(
                this.Fr.sub(
                    blindedCoefficients.slice(i * this.Fr.n8, (i + 1) * this.Fr.n8),
                    blindingFactors[i]
                ),
                i * this.Fr.n8
            );
        }
        this.coeff = blindedCoefficients;
    }

    getCoef(index) {
        if (index > this.degree()) {
            return this.Fr.zero;
        }

        const i_n8 = index * this.Fr.n8;
        return this.coeff.slice(i_n8, i_n8 + this.Fr.n8);
    }

    static async to4T(buffer, domainSize, blindingFactors, Fr) {
        blindingFactors = blindingFactors || [];
        let a = await Fr.ifft(buffer);

        const a4 = new BigBuffer(domainSize * 4 * Fr.n8);
        a4.set(a, 0);

        const a1 = new BigBuffer((domainSize + blindingFactors.length) * Fr.n8);
        a1.set(a, 0);
        for (let i = 0; i < blindingFactors.length; i++) {
            a1.set(
                Fr.add(
                    a1.slice((domainSize + i) * Fr.n8, (domainSize + i + 1) * Fr.n8),
                    blindingFactors[i]
                ),
                (domainSize + i) * Fr.n8
            );
            a1.set(
                Fr.sub(
                    a1.slice(i * Fr.n8, (i + 1) * Fr.n8),
                    blindingFactors[i]
                ),
                i * Fr.n8
            );
        }
        const A4 = await Fr.fft(a4);

        return [a1, A4];
    }

    get length() {
        let length = this.coeff.byteLength / this.Fr.n8;
        if (length !== Math.floor(this.coeff.byteLength / this.Fr.n8)) {
            throw new Error("Polynomial coefficients buffer has incorrect size");
        }
        if (0 === length) {
            if (this.logger) {
                this.logger.warn("Polynomial has length zero");
            }
        }
        return length;
    }

    degree() {
        for (let i = this.length - 1; i > 0; i--) {
            const i_n8 = i * this.Fr.n8;
            if (!this.Fr.eq(this.Fr.zero, this.coeff.slice(i_n8, i_n8 + this.Fr.n8))) {
                return i;
            }
        }

        return 0;
    }

    evaluate(point) {
        let res = this.Fr.zero;

        for (let i = this.length; i > 0; i--) {
            let i_n8 = (i - 1) * this.Fr.n8;
            const currentCoefficient = this.coeff.slice(i_n8, i_n8 + this.Fr.n8);
            res = this.Fr.add(currentCoefficient, this.Fr.mul(res, point));
        }

        return res;
    }

    add(polynomial, blindingValue) {
        // Due to performance reasons currently we only accept to add polynomials with equal or smaller size
        if ((polynomial.degree() + 1) > this.length) {
            throw new Error("Add a greater size polynomial is not allowed");
        }

        const thisDegree = this.degree();
        const polyDegree = polynomial.degree();
        for (let i = 0; i < this.length; i++) {
            const i_n8 = i * this.Fr.n8;

            const a = i <= thisDegree ? this.coeff.slice(i_n8, i_n8 + this.Fr.n8) : this.Fr.zero;
            let b = i <= polyDegree ? polynomial.coeff.slice(i_n8, i_n8 + this.Fr.n8) : this.Fr.zero;
            if (blindingValue !== undefined) {
                b = this.Fr.mul(b, blindingValue);
            }
            this.coeff.set(this.Fr.add(a, b), i_n8);
        }
    }

    sub(polynomial, blindingValue) {
        // Due to performance reasons currently we only accept to add polynomials with equal or smaller size
        if (polynomial.length > this.length) {
            throw new Error("Add a greater size polynomial is not allowed");
        }

        for (let i = 0; i < this.length; i++) {
            const i_n8 = i * this.Fr.n8;

            const a = i < this.degree() ? this.coeff.slice(i_n8, i_n8 + this.Fr.n8) : this.Fr.zero;
            let b = i < polynomial.degree() ? polynomial.coeff.slice(i_n8, i_n8 + this.Fr.n8) : this.Fr.zero;
            if (blindingValue !== undefined) {
                b = this.Fr.mul(b, blindingValue);
            }
            this.coeff.set(this.Fr.sub(a, b), i_n8);
        }
    }

    mulScalar(value) {
        for (let i = 0; i < this.length; i++) {
            const i_n8 = i * this.Fr.n8;

            this.coeff.set(this.Fr.mul(this.coeff.slice(i_n8, i_n8 + this.Fr.n8), value), i_n8);
        }
    }

    addScalar(value) {
        const currentValue = 0 === this.length ? this.Fr.zero : this.coeff.slice(0, this.Fr.n8);
        this.coeff.set(this.Fr.add(currentValue, value), 0);
    }

    subScalar(value) {
        const currentValue = 0 === this.length ? this.Fr.zero : this.coeff.slice(0, this.Fr.n8);
        this.coeff.set(this.Fr.sub(currentValue, value), 0);
    }

    // Divide polynomial by X - value
    divByXValue(value) {
        const coefs = new BigBuffer(this.length * this.Fr.n8);

        coefs.set(this.Fr.zero, (this.length - 1) * this.Fr.n8);
        coefs.set(this.coeff.slice((this.length - 1) * this.Fr.n8, this.length * this.Fr.n8), (this.length - 2) * this.Fr.n8);
        for (let i = this.length - 3; i >= 0; i--) {
            let i_n8 = i * this.Fr.n8;
            coefs.set(
                this.Fr.add(
                    this.coeff.slice(i_n8 + this.Fr.n8, i_n8 + 2 * this.Fr.n8),
                    this.Fr.mul(value, coefs.slice(i_n8 + this.Fr.n8, i_n8 + 2 * this.Fr.n8))
                ),
                i * this.Fr.n8
            );
        }
        if (!this.Fr.eq(
            this.coeff.slice(0, this.Fr.n8),
            this.Fr.mul(this.Fr.neg(value), coefs.slice(0, this.Fr.n8))
        )) {
            // throw new Error("Polynomial does not divide");
        }

        this.coeff = coefs;
    }

    async divZh() {
        const coefs = new BigBuffer(this.domainSize * 4 * this.Fr.n8);

        if (this.logger) this.logger.debug("dividing T/Z_H");
        for (let i = 0; i < this.domainSize; i++) {
            const i_n8 = i * this.Fr.n8;
            coefs.set(this.Fr.neg(this.coeff.slice(i_n8, i_n8 + this.Fr.n8)), i_n8);
        }

        for (let i = this.domainSize; i < this.domainSize * 4; i++) {
            const i_n8 = i * this.Fr.n8;

            const a = this.Fr.sub(
                coefs.slice((i - this.domainSize) * this.Fr.n8, (i - this.domainSize) * this.Fr.n8 + this.Fr.n8),
                this.coeff.slice(i_n8, i_n8 + this.Fr.n8)
            );
            coefs.set(a, i_n8);
            if (i > (this.domainSize * 3 - 4)) {
                if (!this.Fr.isZero(a)) {
                    //throw new Error("range_check T Polynomial is not divisible");
                }
            }
        }

        return new Polynomial(coefs, this.Fr);
    }

    split(numPols, degPols, blindingFactors) {
        if (numPols < 1) {
            throw new Error(`Polynomials can't be split in ${numPols} parts`);
        } else if(1 === numPols) {
            return [this];
        }

        //blinding factors can be void or must have a length of numPols - 1
        if (0 !== blindingFactors.length && blindingFactors.length < numPols - 1) {
            throw new Error(`Blinding factors length must be ${numPols - 1}`);
        }

        const chunkByteLength = (degPols + 1) * this.Fr.n8;
        let res = [];

        // Check polynomial can be split in numChunks parts of chunkSize bytes...
        const numRealPols = Math.ceil((this.degree() + 1) * this.Fr.n8 / chunkByteLength);
        if (numRealPols < numPols) {
            //throw new Error(`Polynomial is short to be split in ${numPols} parts of ${degPols} coefficients each.`);
            for (let i = numRealPols; i < numPols; i++) {
                res[i] = new Polynomial(new Uint8Array(this.Fr.n8), this.Fr, this.logger);
            }
        }

        numPols = Math.min(numPols, numRealPols);
        for (let i = 0; i < numPols; i++) {
            const isLast = (numPols - 1) === i;
            const byteLength = isLast ? this.coeff.byteLength - ((numPols - 1) * chunkByteLength) : chunkByteLength + this.Fr.n8;

            res[i] = new Polynomial(new BigBuffer(byteLength), this.Fr, this.logger);
            const fr = i * chunkByteLength;
            const to = isLast ? this.coeff.byteLength : (i + 1) * chunkByteLength;
            res[i].coeff.set(this.coeff.slice(fr, to), 0);

            // Add a blinding factor as higher degree
            if (!isLast) {
                res[i].coeff.set(blindingFactors[i], chunkByteLength);
            }

            // Sub blinding factor to the lowest degree
            if (0 !== i) {
                const lowestDegree = this.Fr.sub(res[i].coeff.slice(0, this.Fr.n8), blindingFactors[i - 1]);
                res[i].coeff.set(lowestDegree, 0);
            }

            if (isLast) {
                res[i].truncate();
            }
        }

        return res;

        // // compute t_low(X)
        // let polTLow = new BigBuffer((chunkSize + 1) * n8r);
        // polTLow.set(t.slice(0, zkey.domainSize * n8r), 0);
        // // Add blinding scalar b_10 as a new coefficient n
        // polTLow.set(ch.b[10], zkey.domainSize * n8r);
        //
        // // compute t_mid(X)
        // let polTMid = new BigBuffer((zkey.domainSize + 1) * n8r);
        // polTMid.set(t.slice(zkey.domainSize * n8r, zkey.domainSize * 2 * n8r), 0);
        // // Subtract blinding scalar b_10 to the lowest coefficient of t_mid
        // const lowestMid = Fr.sub(polTMid.slice(0, n8r), ch.b[10]);
        // polTMid.set(lowestMid, 0);
        // // Add blinding scalar b_11 as a new coefficient n
        // polTMid.set(ch.b[11], zkey.domainSize * n8r);
        //
        // // compute t_high(X)
        // let polTHigh = new BigBuffer((zkey.domainSize + 6) * n8r);
        // polTHigh.set(t.slice(zkey.domainSize * 2 * n8r, (zkey.domainSize * 3 + 6) * n8r), 0);
        // //Subtract blinding scalar b_11 to the lowest coefficient of t_high
        // const lowestHigh = Fr.sub(polTHigh.slice(0, n8r), ch.b[11]);
        // polTHigh.set(lowestHigh, 0);
        //
        // proof.T1 = await expTau(polTLow, "multiexp T1");
        // proof.T2 = await expTau(polTMid, "multiexp T2");
        // proof.T3 = await expTau(polTHigh, "multiexp T3");
    }

    // split2(degPols, blindingFactors) {
    //     let currentDegree = this.degree();
    //     const numFilledPols = Math.ceil((currentDegree + 1) / (degPols + 1));
    //
    //     //blinding factors can be void or must have a length of numPols - 1
    //     if (0 !== blindingFactors.length && blindingFactors.length < numFilledPols - 1) {
    //         throw new Error(`Blinding factors length must be ${numFilledPols - 1}`);
    //     }
    //
    //     const chunkByteLength = (degPols + 1) * this.Fr.n8;
    //
    //     // Check polynomial can be split in numChunks parts of chunkSize bytes...
    //     if (this.coeff.byteLength / chunkByteLength <= numFilledPols - 1) {
    //         throw new Error(`Polynomial is short to be split in ${numFilledPols} parts of ${degPols} coefficients each.`);
    //     }
    //
    //     let res = [];
    //     for (let i = 0; i < numFilledPols; i++) {
    //         const isLast = (numFilledPols - 1) === i;
    //         const byteLength = isLast ? (currentDegree + 1) * this.Fr.n8 - ((numFilledPols - 1) * chunkByteLength) : chunkByteLength + this.Fr.n8;
    //
    //         res[i] = new Polynomial(new BigBuffer(byteLength), this.Fr, this.logger);
    //         const fr = i * chunkByteLength;
    //         const to = isLast ? (currentDegree + 1) * this.Fr.n8 : (i + 1) * chunkByteLength;
    //         res[i].coeff.set(this.coeff.slice(fr, to), 0);
    //
    //         // Add a blinding factor as higher degree
    //         if (!isLast) {
    //             res[i].coeff.set(blindingFactors[i], chunkByteLength);
    //         }
    //
    //         // Sub blinding factor to the lowest degree
    //         if (0 !== i) {
    //             const lowestDegree = this.Fr.sub(res[i].coeff.slice(0, this.Fr.n8), blindingFactors[i - 1]);
    //             res[i].coeff.set(lowestDegree, 0);
    //         }
    //     }
    //
    //     return res;
    // }

    // merge(pols, overlap = true) {
    //     let length = 0;
    //     for (let i = 0; i < pols.length; i++) {
    //         length += pols[i].length();
    //     }
    //
    //     if (overlap) {
    //         length -= pols.length - 1;
    //     }
    //
    //     let res = new Polynomial(new BigBuffer(length * this.Fr.n8));
    //     for (let i = 0; i < pols.length; i++) {
    //         const byteLength = pols[i].coeff.byteLength;
    //         if (0 === i) {
    //             res.coeff.set(pols[i].coeff, 0);
    //         } else {
    //
    //         }
    //     }
    //
    //     return res;
    // }

    truncate() {
        const deg = this.degree();
        if (deg + 1 < this.coeff.byteLength / this.Fr.n8) {
            const newCoefs = new BigBuffer((deg + 1) * this.Fr.n8);
            newCoefs.set(this.coeff.slice(0, (deg + 1) * this.Fr.n8), 0);
            this.coeff = newCoefs;
        }
    }
}