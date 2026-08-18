type KimiLogoProps = {
  className?: string;
};

const KimiLogo = ({ className = 'w-5 h-5' }: KimiLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Kimi Code"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2.5" y="2.5" width="19" height="19" rx="6" className="fill-violet-600" />
    <path
      d="M7.2 6.7v10.6M16.7 6.8l-7.4 7.7M11.8 11.9l5.2 5.4"
      className="stroke-white"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default KimiLogo;
