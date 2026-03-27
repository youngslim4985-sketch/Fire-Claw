/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { 
  GoogleAuthProvider, 
  signInWithPopup, 
  onAuthStateChanged, 
  User as FirebaseUser,
  signOut
} from 'firebase/auth';
import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  query, 
  where, 
  orderBy, 
  addDoc,
  Timestamp,
  getDocFromServer
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { GoogleGenAI } from "@google/genai";
import Markdown from 'react-markdown';
import { 
  Search, 
  Database, 
  Settings, 
  LogOut, 
  Globe, 
  FileText, 
  Cpu, 
  AlertCircle, 
  CheckCircle2, 
  Loader2,
  ExternalLink,
  Trash2,
  ChevronRight,
  ShieldCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { cn } from './lib/utils';

// --- Types ---

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: any[];
  }
}

interface UserProfile {
  uid: string;
  email: string;
  firecrawlApiKey?: string;
  role: 'admin' | 'user';
  createdAt: any;
}

interface ScrapeResult {
  id: string;
  userId: string;
  url: string;
  status: 'pending' | 'completed' | 'failed';
  markdown?: string;
  metadata?: any;
  createdAt: any;
}

// --- Helpers ---

const handleFirestoreError = (error: unknown, operationType: OperationType, path: string | null) => {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
};

// --- Components ---

const ErrorBoundary = ({ children }: { children: React.ReactNode }) => {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      try {
        const parsed = JSON.parse(event.error.message);
        if (parsed.error) {
          setError(`Firestore Error: ${parsed.error} during ${parsed.operationType} on ${parsed.path}`);
        }
      } catch {
        setError(event.error.message);
      }
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  if (error) {
    return (
      <div className="min-h-screen bg-[#E4E3E0] flex items-center justify-center p-4">
        <div className="bg-white border border-[#141414] p-8 max-w-md w-full shadow-[8px_8px_0px_0px_rgba(20,20,20,1)]">
          <div className="flex items-center gap-3 text-red-600 mb-4">
            <AlertCircle size={24} />
            <h2 className="font-serif italic text-xl font-bold uppercase tracking-tight">System Error</h2>
          </div>
          <p className="font-mono text-sm text-[#141414] mb-6 break-words">{error}</p>
          <button 
            onClick={() => window.location.reload()}
            className="w-full bg-[#141414] text-[#E4E3E0] py-3 font-mono text-sm uppercase tracking-widest hover:bg-opacity-90 transition-all"
          >
            Restart System
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [scrapes, setScrapes] = useState<ScrapeResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'scrapes' | 'settings'>('dashboard');
  const [targetUrl, setTargetUrl] = useState('');
  const [isScraping, setIsScraping] = useState(false);
  const [selectedScrape, setSelectedScrape] = useState<ScrapeResult | null>(null);
  const [aiInsight, setAiInsight] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // --- Auth & Profile ---

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        try {
          const userDoc = await getDoc(doc(db, 'users', u.uid));
          if (userDoc.exists()) {
            setProfile(userDoc.data() as UserProfile);
          } else {
            const newProfile: UserProfile = {
              uid: u.uid,
              email: u.email || '',
              role: 'user',
              createdAt: Timestamp.now()
            };
            await setDoc(doc(db, 'users', u.uid), newProfile);
            setProfile(newProfile);
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.GET, `users/${u.uid}`);
        }
      } else {
        setProfile(null);
      }
      setIsAuthReady(true);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // --- Connection Test ---
  useEffect(() => {
    if (isAuthReady && user) {
      const testConnection = async () => {
        try {
          await getDocFromServer(doc(db, 'test', 'connection'));
        } catch (error) {
          if (error instanceof Error && error.message.includes('the client is offline')) {
            console.error("Firebase connection error: check configuration.");
          }
        }
      };
      testConnection();
    }
  }, [isAuthReady, user]);

  // --- Data Listeners ---

  useEffect(() => {
    if (!user || !isAuthReady) return;

    const q = query(
      collection(db, 'scrapes'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ScrapeResult));
      setScrapes(results);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'scrapes');
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  // --- Actions ---

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  const handleScrape = async () => {
    if (!targetUrl || !profile?.firecrawlApiKey) return;
    setIsScraping(true);
    
    try {
      // 1. Create pending record
      const scrapeRef = await addDoc(collection(db, 'scrapes'), {
        userId: user!.uid,
        url: targetUrl,
        status: 'pending',
        createdAt: Timestamp.now()
      });

      // 2. Call Firecrawl API
      const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${profile.firecrawlApiKey}`
        },
        body: JSON.stringify({
          url: targetUrl,
          formats: ['markdown']
        })
      });

      if (!response.ok) throw new Error('Firecrawl API error');
      const result = await response.json();

      // 3. Update record
      await setDoc(doc(db, 'scrapes', scrapeRef.id), {
        status: 'completed',
        markdown: result.data.markdown,
        metadata: result.data.metadata || {},
      }, { merge: true });

      setTargetUrl('');
    } catch (error) {
      console.error('Scrape failed:', error);
    } finally {
      setIsScraping(false);
    }
  };

  const handleAnalyze = async (markdown: string) => {
    if (!markdown) return;
    setIsAnalyzing(true);
    setAiInsight(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Analyze the following scraped web content and extract key business insights, contact info, and a summary: \n\n ${markdown}`,
        config: {
          systemInstruction: "You are a business intelligence expert. Provide concise, structured insights from web data."
        }
      });
      setAiInsight(response.text);
    } catch (error) {
      console.error('Analysis failed:', error);
      setAiInsight("Failed to generate AI insights.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const updateApiKey = async (key: string) => {
    if (!user) return;
    try {
      await setDoc(doc(db, 'users', user.uid), { firecrawlApiKey: key }, { merge: true });
      setProfile(prev => prev ? { ...prev, firecrawlApiKey: key } : null);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`);
    }
  };

  // --- Renderers ---

  if (loading) {
    return (
      <div className="min-h-screen bg-[#E4E3E0] flex items-center justify-center">
        <Loader2 className="animate-spin text-[#141414]" size={48} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#E4E3E0] flex flex-col items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-xl w-full text-center"
        >
          <h1 className="font-serif italic text-6xl md:text-8xl text-[#141414] leading-none mb-8 uppercase tracking-tighter">
            Firecrawl <br /> AI Engine
          </h1>
          <p className="font-mono text-sm text-[#141414] opacity-70 mb-12 uppercase tracking-widest">
            Multi-tenant data ingestion & intelligence platform
          </p>
          <button 
            onClick={handleLogin}
            className="group relative inline-flex items-center gap-3 bg-[#141414] text-[#E4E3E0] px-12 py-5 font-mono text-sm uppercase tracking-[0.2em] hover:bg-opacity-90 transition-all shadow-[8px_8px_0px_0px_rgba(20,20,20,0.2)]"
          >
            Initialize Session
            <ChevronRight className="group-hover:translate-x-1 transition-transform" size={18} />
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
        {/* Navigation Rail */}
        <nav className="fixed left-0 top-0 h-full w-20 border-r border-[#141414] flex flex-col items-center py-8 gap-12 z-50 bg-[#E4E3E0]">
          <div className="font-serif italic text-2xl font-bold border-2 border-[#141414] w-12 h-12 flex items-center justify-center">F</div>
          
          <div className="flex flex-col gap-8">
            <NavIcon active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} icon={<Globe size={24} />} label="Dash" />
            <NavIcon active={activeTab === 'scrapes'} onClick={() => setActiveTab('scrapes')} icon={<Database size={24} />} label="Data" />
            <NavIcon active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<Settings size={24} />} label="Config" />
          </div>

          <button 
            onClick={() => signOut(auth)}
            className="mt-auto p-3 hover:bg-[#141414] hover:text-[#E4E3E0] transition-colors rounded-full"
          >
            <LogOut size={24} />
          </button>
        </nav>

        {/* Main Content */}
        <main className="pl-20 min-h-screen">
          <header className="h-20 border-b border-[#141414] flex items-center justify-between px-12">
            <div className="flex items-center gap-4">
              <span className="font-mono text-[10px] uppercase tracking-widest opacity-50">System Status</span>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                <span className="font-mono text-[10px] uppercase tracking-widest">Operational</span>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-right">
                <p className="font-mono text-[10px] uppercase tracking-widest opacity-50">Authenticated User</p>
                <p className="font-mono text-xs font-bold">{user.email}</p>
              </div>
              <div className="w-10 h-10 border border-[#141414] rounded-full overflow-hidden">
                <img src={user.photoURL || ''} alt="" referrerPolicy="no-referrer" />
              </div>
            </div>
          </header>

          <div className="p-12">
            <AnimatePresence mode="wait">
              {activeTab === 'dashboard' && (
                <motion.div 
                  key="dashboard"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="grid grid-cols-1 lg:grid-cols-3 gap-12"
                >
                  <div className="lg:col-span-2 space-y-12">
                    <section>
                      <h2 className="font-serif italic text-4xl mb-8">Data Ingestion Engine</h2>
                      <div className="bg-white border border-[#141414] p-8 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)]">
                        <p className="font-mono text-[10px] uppercase tracking-widest opacity-50 mb-4">Target URL</p>
                        <div className="flex gap-4">
                          <input 
                            type="url" 
                            placeholder="https://example.com"
                            value={targetUrl}
                            onChange={(e) => setTargetUrl(e.target.value)}
                            className="flex-1 bg-transparent border-b border-[#141414] py-2 font-mono text-sm focus:outline-none focus:border-opacity-50"
                          />
                          <button 
                            onClick={handleScrape}
                            disabled={isScraping || !profile?.firecrawlApiKey}
                            className="bg-[#141414] text-[#E4E3E0] px-8 py-3 font-mono text-xs uppercase tracking-widest disabled:opacity-30 flex items-center gap-2"
                          >
                            {isScraping ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}
                            Execute Scrape
                          </button>
                        </div>
                        {!profile?.firecrawlApiKey && (
                          <p className="mt-4 font-mono text-[10px] text-red-600 uppercase">API Key Required. Visit Config to set up.</p>
                        )}
                      </div>
                    </section>

                    <section>
                      <div className="flex items-center justify-between mb-8">
                        <h2 className="font-serif italic text-4xl">Recent Ingestions</h2>
                        <button onClick={() => setActiveTab('scrapes')} className="font-mono text-[10px] uppercase tracking-widest hover:underline">View All</button>
                      </div>
                      <div className="space-y-4">
                        {scrapes.slice(0, 5).map((scrape) => (
                          <div 
                            key={scrape.id}
                            onClick={() => { setSelectedScrape(scrape); setActiveTab('scrapes'); }}
                            className="group flex items-center justify-between p-6 bg-white border border-[#141414] hover:bg-[#141414] hover:text-[#E4E3E0] transition-all cursor-pointer"
                          >
                            <div className="flex items-center gap-6">
                              <div className={cn(
                                "w-2 h-2 rounded-full",
                                scrape.status === 'completed' ? "bg-green-500" : scrape.status === 'failed' ? "bg-red-500" : "bg-yellow-500 animate-pulse"
                              )} />
                              <div>
                                <p className="font-mono text-xs font-bold truncate max-w-md">{scrape.url}</p>
                                <p className="font-mono text-[10px] uppercase opacity-50">{format(scrape.createdAt.toDate(), 'MMM d, HH:mm')}</p>
                              </div>
                            </div>
                            <ChevronRight size={18} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>

                  <div className="space-y-12">
                    <section className="bg-white border border-[#141414] p-8">
                      <h3 className="font-serif italic text-2xl mb-6">System Metrics</h3>
                      <div className="space-y-6">
                        <Metric label="Total Scrapes" value={scrapes.length.toString()} />
                        <Metric label="Active Sessions" value="1" />
                        <Metric label="API Latency" value="240ms" />
                      </div>
                    </section>

                    <section className="bg-[#141414] text-[#E4E3E0] p-8 shadow-[8px_8px_0px_0px_rgba(255,255,255,0.1)]">
                      <div className="flex items-center gap-3 mb-6">
                        <Cpu size={20} />
                        <h3 className="font-serif italic text-2xl">AI Intelligence</h3>
                      </div>
                      <p className="font-mono text-[10px] leading-relaxed opacity-70 mb-6">
                        Gemini 3 Flash is integrated for real-time data synthesis and lead scoring.
                      </p>
                      <div className="p-4 border border-white border-opacity-20 rounded">
                        <p className="font-mono text-[10px] uppercase tracking-widest opacity-50 mb-2">Current Model</p>
                        <p className="font-mono text-xs">gemini-3-flash-preview</p>
                      </div>
                    </section>
                  </div>
                </motion.div>
              )}

              {activeTab === 'scrapes' && (
                <motion.div 
                  key="scrapes"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="grid grid-cols-1 lg:grid-cols-12 gap-12"
                >
                  <div className="lg:col-span-4 space-y-4 max-h-[calc(100vh-200px)] overflow-y-auto pr-4 scrollbar-hide">
                    <h2 className="font-serif italic text-4xl mb-8 sticky top-0 bg-[#E4E3E0] py-4 z-10">Data Repository</h2>
                    {scrapes.map((scrape) => (
                      <div 
                        key={scrape.id}
                        onClick={() => { setSelectedScrape(scrape); setAiInsight(null); }}
                        className={cn(
                          "p-6 border border-[#141414] transition-all cursor-pointer",
                          selectedScrape?.id === scrape.id ? "bg-[#141414] text-[#E4E3E0]" : "bg-white hover:bg-gray-50"
                        )}
                      >
                        <p className="font-mono text-xs font-bold truncate mb-2">{scrape.url}</p>
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[10px] uppercase opacity-50">{format(scrape.createdAt.toDate(), 'MMM d, yyyy')}</span>
                          <span className={cn(
                            "font-mono text-[10px] uppercase px-2 py-1 border",
                            scrape.status === 'completed' ? "border-green-500 text-green-500" : "border-red-500 text-red-500"
                          )}>{scrape.status}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="lg:col-span-8 bg-white border border-[#141414] p-12 shadow-[12px_12px_0px_0px_rgba(20,20,20,1)] min-h-[600px]">
                    {selectedScrape ? (
                      <div className="space-y-8">
                        <div className="flex items-center justify-between border-b border-[#141414] pb-8">
                          <div>
                            <h3 className="font-serif italic text-3xl mb-2">Ingestion Details</h3>
                            <p className="font-mono text-xs opacity-50">{selectedScrape.url}</p>
                          </div>
                          <div className="flex gap-4">
                            <button 
                              onClick={() => handleAnalyze(selectedScrape.markdown || '')}
                              disabled={isAnalyzing || !selectedScrape.markdown}
                              className="flex items-center gap-2 bg-[#141414] text-[#E4E3E0] px-6 py-3 font-mono text-xs uppercase tracking-widest disabled:opacity-30"
                            >
                              {isAnalyzing ? <Loader2 className="animate-spin" size={16} /> : <Cpu size={16} />}
                              AI Insight
                            </button>
                            <a 
                              href={selectedScrape.url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="p-3 border border-[#141414] hover:bg-gray-50 transition-colors"
                            >
                              <ExternalLink size={20} />
                            </a>
                          </div>
                        </div>

                        {aiInsight && (
                          <motion.div 
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="bg-[#141414] text-[#E4E3E0] p-8 rounded-sm"
                          >
                            <div className="flex items-center gap-2 mb-4 text-blue-400">
                              <ShieldCheck size={18} />
                              <span className="font-mono text-[10px] uppercase tracking-widest">Gemini Synthesis</span>
                            </div>
                            <div className="font-mono text-sm leading-relaxed prose prose-invert max-w-none">
                              <Markdown>{aiInsight}</Markdown>
                            </div>
                          </motion.div>
                        )}

                        <div className="prose prose-sm max-w-none font-sans text-[#141414]">
                          <p className="font-mono text-[10px] uppercase tracking-widest opacity-50 mb-4">Markdown Content</p>
                          <div className="p-8 bg-gray-50 border border-[#141414] border-opacity-10 overflow-x-auto">
                            <Markdown>{selectedScrape.markdown || 'No content extracted.'}</Markdown>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center text-center opacity-30">
                        <FileText size={64} className="mb-6" />
                        <p className="font-serif italic text-2xl">Select a record to view intelligence</p>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}

              {activeTab === 'settings' && (
                <motion.div 
                  key="settings"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="max-w-2xl"
                >
                  <h2 className="font-serif italic text-4xl mb-12">System Configuration</h2>
                  
                  <div className="space-y-12">
                    <section className="bg-white border border-[#141414] p-8 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)]">
                      <div className="flex items-center gap-3 mb-6">
                        <Settings size={20} />
                        <h3 className="font-serif italic text-2xl">Firecrawl API</h3>
                      </div>
                      <p className="font-mono text-xs opacity-50 mb-6">
                        Your API key is used to authenticate requests to the Firecrawl scraping engine.
                      </p>
                      <div className="space-y-4">
                        <p className="font-mono text-[10px] uppercase tracking-widest opacity-50">API Key</p>
                        <input 
                          type="password" 
                          defaultValue={profile?.firecrawlApiKey || ''}
                          onBlur={(e) => updateApiKey(e.target.value)}
                          placeholder="fc-..."
                          className="w-full bg-transparent border-b border-[#141414] py-2 font-mono text-sm focus:outline-none"
                        />
                        <p className="font-mono text-[10px] opacity-50">Changes are saved automatically on blur.</p>
                      </div>
                    </section>

                    <section className="bg-white border border-[#141414] p-8">
                      <div className="flex items-center gap-3 mb-6">
                        <ShieldCheck size={20} />
                        <h3 className="font-serif italic text-2xl">Account Security</h3>
                      </div>
                      <div className="space-y-4">
                        <div className="flex justify-between items-center py-4 border-b border-[#141414] border-opacity-10">
                          <span className="font-mono text-xs uppercase">Role</span>
                          <span className="font-mono text-xs font-bold uppercase">{profile?.role}</span>
                        </div>
                        <div className="flex justify-between items-center py-4 border-b border-[#141414] border-opacity-10">
                          <span className="font-mono text-xs uppercase">Member Since</span>
                          <span className="font-mono text-xs font-bold">{profile ? format(profile.createdAt.toDate(), 'MMM d, yyyy') : '-'}</span>
                        </div>
                      </div>
                    </section>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>
    </ErrorBoundary>
  );
}

function NavIcon({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "group relative flex flex-col items-center gap-1 p-3 transition-all",
        active ? "text-[#141414]" : "text-[#141414] opacity-30 hover:opacity-100"
      )}
    >
      {icon}
      <span className="font-mono text-[8px] uppercase tracking-widest">{label}</span>
      {active && (
        <motion.div 
          layoutId="nav-indicator"
          className="absolute -right-10 w-1 h-8 bg-[#141414]"
        />
      )}
    </button>
  );
}

function Metric({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex justify-between items-end border-b border-[#141414] border-opacity-10 pb-4">
      <span className="font-mono text-[10px] uppercase tracking-widest opacity-50">{label}</span>
      <span className="font-serif italic text-3xl leading-none">{value}</span>
    </div>
  );
}
