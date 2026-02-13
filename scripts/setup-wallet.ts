import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const keypair = Keypair.generate();
const privateKey = bs58.encode(keypair.secretKey);

console.log('=== New Solana Wallet ===');
console.log(`Public Key:  ${keypair.publicKey.toBase58()}`);
console.log(`Private Key: ${privateKey}`);
console.log('');
console.log('Add to your .env file:');
console.log(`PRIVATE_KEY=${privateKey}`);
console.log('');
console.log('IMPORTANT: Save the private key securely. Never share it.');
