// guide.js -- optional first-run help for people who have never tracked food.
// The invitation is quiet, appears once, and never blocks logging. The full guide
// remains available from Settings after either completion or dismissal.

const EATIFY_GUIDE_KEY = 'ledger_guide_v1';
const EATIFY_GUIDE_STEPS = [
  {
    kicker:'Set a goal',
    title:'Tell Eatify what you want to do',
    copy:'Open <strong>Settings → Calories & goals</strong>. Choose lose weight, maintain weight, or gain slowly. Eatify will work out a starting calorie range. You can change it later when you have more data.',
    tip:'If you are unsure, start with Maintain. Log normally for a week, then choose a goal.'
  },
  {
    kicker:'Log meals',
    title:'Write what you ate in normal language',
    copy:'Use the box at the bottom of Today. You can type something like <strong>chicken pulao and raita</strong> or add a photo. Check the result before saving it. Add a weight when you know it; otherwise leave it as an estimate.',
    tip:'You do not need perfect measurements. Try to log everything, including drinks and snacks.'
  },
  {
    kicker:'Read Today',
    title:'Watch the calorie range and protein target',
    copy:'The calorie range is the main daily target. The protein number is a minimum to aim for. You can look at carbs, fat, and vitamins later; they do not all need your attention when you are starting.',
    tip:'Most days, getting close to the calorie range and protein target is enough.'
  },
  {
    kicker:'Track progress',
    title:'Use several weigh-ins, not one',
    copy:'Add your weight under <strong>Logs</strong> a few mornings each week. Try to weigh after using the bathroom and before eating. Daily weight changes because of water and food, so Eatify looks at the longer trend.',
    tip:'Wait for at least two weeks of fairly regular logging before making a big calorie change.'
  },
  {
    kicker:'Save time',
    title:'Reuse meals you eat often',
    copy:'Open <strong>Offline meals</strong> to find anything you logged before. Pin regular meals so they stay at the top. They work without internet, and you can change the serving size before adding them.',
    tip:'Sign in if you want your meals, settings, and progress on more than one device.'
  }
];

const EATIFY_SETTINGS_HELP = {
  'Calories & goals': {
    intro:'This section decides the calorie and protein numbers shown on Today.',
    start:'Easy setup: choose a goal, keep the suggested calorie range, leave carb and fat caps blank, and skip the meal schedule unless you want pacing reminders.',
    items:[
      ['Goal','Lose weight lowers your daily calories, Maintain keeps them near your estimated needs, and Gain slowly adds a small surplus. “Use my calorie range” leaves the numbers entirely up to you.'],
      ['Custom calorie adjustment','For experienced users who want a specific surplus or deficit. A negative number reduces calories; a positive number adds them.'],
      ['Calorie floor and ceiling','Your daily target range. The floor is the lower end and the ceiling is the upper end. A range is easier to live with than one exact number.'],
      ['Protein floor','The minimum protein to aim for each day. Keep grams selected unless you already plan macros as percentages.'],
      ['Carb and fat caps','Optional upper limits. Leave them blank if you only care about calories and protein.'],
      ['Meal schedule','Optional times and calorie shares for your usual meals. It changes pacing messages during the day, not your total daily target.'],
      ['Reset to defaults','Restores Eatify’s starting targets. It does not delete any meal history.']
    ]
  },
  'Body profile': {
    intro:'Eatify uses this information to estimate maintenance calories before it has enough history to learn from.',
    start:'Enter sex, age, and height. Choose the lower activity level if you are between two options; workouts are already handled separately.',
    items:[
      ['Sex, age, and height','Used only in the starting calorie estimate. Height is entered in centimetres.'],
      ['Activity','Sedentary means mostly seated; Light means regular walking; Moderate means an active routine or several workouts a week; Active means you move for much of the day; Athlete is for very high training volume.'],
      ['Ignore older weigh-ins','Leave this blank normally. Set a date only after a major diet change caused a large water-weight shift and the older readings are distorting the estimate.'],
      ['Maintenance estimate','This is roughly how many calories would keep your weight stable. It becomes more personal as you log food and weight consistently.']
    ]
  },
  'Training': {
    intro:'This is optional. It helps Eatify open the right workout screen and, if you choose, use different calorie targets on training and rest days.',
    start:'Select your training days and enter the usual workout window. Leave calorie cycling off at first.',
    items:[
      ['Training days','Select the days you normally train.'],
      ['Weekly split','Name the workout for each day, such as Pull, Push, Legs, or Rest. This labels sessions and helps repeat the right workout.'],
      ['Workout start and end','Your usual training time. Eatify can open directly on Lift during this window.'],
      ['Open on Lift','Turn this on if you normally open Eatify while training.'],
      ['Different targets by day','Moves calories between training and rest days. The training-day and rest-day offsets say how many calories to add or remove. Keep this off unless you already know why you want it.']
    ]
  },
  'Food logging & AI': {
    intro:'Eatify includes meal analysis and food search. Personal API keys are optional and only matter after the included allowance is used.',
    start:'Most people should leave this whole section alone. Sign in, use the included allowance, and keep the estimate adjustments at their defaults.',
    items:[
      ['Included allowance','Each signed-in account gets 15 meal analyses and 40 food searches per day. Manual and offline logging do not use this allowance.'],
      ['USDA key','Lets food search continue with your own USDA allowance after Eatify’s allowance runs out.'],
      ['Gemini key','Lets photo and text meal analysis continue with your own Gemini allowance.'],
      ['Gemini model','Chooses the Gemini model used with your personal key. Leave the default unless a model is unavailable or you know you want another one.'],
      ['OpenRouter key','Optional backup for text analysis if Gemini is unavailable.'],
      ['Estimate adjustments','Unweighed meals tend to be under-reported. Eatify can add a percentage to estimated calories and reduce estimated protein. These changes affect estimates only, not weighed meals.'],
      ['Personal-key storage','Keys stay saved in this browser and are excluded from account sync and exports. They are sent only when that provider is used.']
    ]
  },
  'Account & sync': {
    intro:'An account keeps the same Eatify data available across your devices.',
    start:'Enter your email, open the sign-in link, then press Sync now on each device the first time.',
    items:[
      ['Email sign-in','Eatify sends a sign-in link instead of asking you to create a password. Use the same email on every device.'],
      ['Sync now','Downloads newer data, merges it with this device, and uploads the combined result. Automatic sync continues after sign-in.'],
      ['Sign out','Stops account sync on this device. Your local data stays on the device.'],
      ['Your own Supabase project','An advanced option for people hosting their own backend. Leave both fields blank to use Eatify’s built-in service.'],
      ['What syncs','Meals, targets, workouts, measurements, supplements, and saved usuals sync. Personal API keys do not.']
    ]
  },
  'Backup & reset': {
    intro:'Sync is convenient, but an exported file is the safest copy you control yourself.',
    start:'Export a backup occasionally. Import only a backup you recognise. Clear day affects the date currently open on screen.',
    items:[
      ['Export backup','Downloads your Eatify data as a file you can store somewhere safe. API keys are excluded.'],
      ['Import backup','Restores data from an Eatify backup and merges supported records into this device.'],
      ['Clear this day','Removes entries from the date currently being viewed. Other days are left alone.']
    ]
  }
};

function buildSettingsHelp(title){
  const info=EATIFY_SETTINGS_HELP[title];
  const details=document.createElement('details'); details.className='settings-help';
  const summary=document.createElement('summary'); summary.textContent='How to set this up'; details.appendChild(summary);
  if(!info)return details;
  const intro=document.createElement('p'); intro.textContent=info.intro; details.appendChild(intro);
  const start=document.createElement('div'); start.className='settings-help-start'; start.textContent=info.start; details.appendChild(start);
  const list=document.createElement('dl');
  info.items.forEach(([name,text])=>{const dt=document.createElement('dt');dt.textContent=name;const dd=document.createElement('dd');dd.textContent=text;list.append(dt,dd);});
  details.appendChild(list); return details;
}

function hideEatifyGuideInvite(state){
  const card=document.getElementById('guideInvite');
  if(card)card.hidden=true;
  if(state)setKey(EATIFY_GUIDE_KEY,state);
}

function maybeOfferEatifyGuide(){
  const card=document.getElementById('guideInvite');
  if(!card||getKey(EATIFY_GUIDE_KEY))return;
  card.hidden=false;
}

function startEatifyGuide(startAt){
  hideEatifyGuideInvite();
  let at=Math.max(0,Math.min(EATIFY_GUIDE_STEPS.length-1,+startAt||0));
  return openSheet((sheet,close)=>{
    sheet.classList.add('guide-sheet');
    const progress=document.createElement('div'); progress.className='guide-progress';
    const kicker=document.createElement('div'); kicker.className='guide-kicker';
    const title=document.createElement('h2');
    const copy=document.createElement('div'); copy.className='guide-copy';
    const rule=document.createElement('div'); rule.className='guide-rule';
    const actions=document.createElement('div'); actions.className='footer-actions';
    const back=document.createElement('button'); back.type='button'; back.className='ghost'; back.textContent='Back';
    const next=document.createElement('button'); next.type='button';
    actions.append(back,next); sheet.append(progress,kicker,title,copy,rule,actions);
    const draw=()=>{
      const step=EATIFY_GUIDE_STEPS[at];
      progress.innerHTML=EATIFY_GUIDE_STEPS.map((_,i)=>`<span class="${i<=at?'on':''}"></span>`).join('');
      kicker.textContent=`${step.kicker} · ${at+1} of ${EATIFY_GUIDE_STEPS.length}`;
      title.textContent=step.title; copy.innerHTML=step.copy; rule.textContent=step.tip;
      back.hidden=at===0; next.textContent=at===EATIFY_GUIDE_STEPS.length-1?'Got it':'Next';
    };
    back.onclick=()=>{if(at>0){at--;draw();}};
    next.onclick=()=>{
      if(at<EATIFY_GUIDE_STEPS.length-1){at++;draw();return;}
      setKey(EATIFY_GUIDE_KEY,'complete'); close(true); toast('Walkthrough complete · reopen it from Settings anytime');
    };
    draw(); return next;
  });
}

document.getElementById('guideStart').onclick=()=>startEatifyGuide();
document.getElementById('guideDismiss').onclick=()=>hideEatifyGuideInvite('dismissed');
